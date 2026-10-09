/**
 * Non-destructive: gives a placeholder avatar to children that have NO photo (never overwrites a real photo, never deletes data).
 *   npm run avatars                       # all children without photo
 *   npm run avatars -- "Nguyễn Gia An"    # only children with this exact name
 */
import dataSource from './data-source';
import { writePlaceholderAvatar } from '../common/avatar';

(async () => {
  await dataSource.initialize();
  const name = process.argv[2];
  // idx = position in creation order, so avatars cycle exactly like the seed (kids[i] -> avatar-(i%10+1))
  const rows: { id: string; full_name: string; idx: number }[] = await dataSource.query(`
    SELECT * FROM (SELECT id, full_name, photo_url, (ROW_NUMBER() OVER (ORDER BY created_at, id) - 1)::int AS idx FROM children) c
    WHERE photo_url IS NULL ${name ? 'AND full_name = $1' : ''} ORDER BY idx`, name ? [name] : []);
  for (const c of rows) {
    const key = await writePlaceholderAvatar(c.id, c.idx);
    await dataSource.query('UPDATE children SET photo_url = $1 WHERE id = $2 AND photo_url IS NULL', [key, c.id]);
    console.log(`${c.full_name}: ${key} (avatar #${(c.idx % 10) + 1})`);
  }
  console.log(`${rows.length} children updated`);
  await dataSource.destroy();
})().catch((e) => { console.error(e); process.exit(1); });
