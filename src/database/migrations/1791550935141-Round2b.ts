import { MigrationInterface, QueryRunner } from "typeorm";

export class Round2b1791550935141 implements MigrationInterface {
    name = 'Round2b1791550935141'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "holidays" ADD "reason" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "holidays" DROP COLUMN "reason"`);
    }

}
