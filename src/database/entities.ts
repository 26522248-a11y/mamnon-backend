import {
  Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, OneToMany, OneToOne, PrimaryColumn,
  PrimaryGeneratedColumn, Unique, UpdateDateColumn,
} from 'typeorm';

export type Role = 'admin' | 'teacher' | 'accountant' | 'parent';
export const ROLES: Role[] = ['admin', 'teacher', 'accountant', 'parent'];
export type AttStatus = 'present' | 'absent' | 'late';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Index({ unique: true }) @Column({ length: 64 }) username!: string;
  @Column({ name: 'password_hash' }) passwordHash!: string;
  @Column({ length: 120 }) name!: string;
  @Column({ type: 'enum', enum: ROLES, enumName: 'user_role' }) role!: Role;
  @Column({ type: 'varchar', nullable: true, length: 20 }) phone!: string | null;
  @Column({ name: 'is_active', default: true }) isActive!: boolean;
  @Column({ name: 'token_version', default: 0 }) tokenVersion!: number;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
}

@Entity('classes')
export class ClassRoom {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ length: 80 }) name!: string;
  @Column({ name: 'age_group', length: 40 }) ageGroup!: string;
  @Column({ name: 'school_year', type: 'varchar', length: 20, nullable: true }) schoolYear!: string | null;
  @Column({ type: 'varchar', length: 40, nullable: true }) room!: string | null;
  @Column({ type: 'int', nullable: true }) capacity!: number | null;
  @OneToMany(() => ClassTeacher, (ct) => ct.classRoom) teachers!: ClassTeacher[];
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
}

@Entity('class_teachers')
export class ClassTeacher {
  @PrimaryColumn('uuid', { name: 'class_id' }) classId!: string;
  @PrimaryColumn('uuid', { name: 'user_id' }) userId!: string;
  @Column({ name: 'is_head', default: false }) isHead!: boolean;
  @ManyToOne(() => ClassRoom, (c) => c.teachers, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'class_id' }) classRoom!: ClassRoom;
  @ManyToOne(() => User, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'user_id' }) user!: User;
}

@Entity('children')
export class Child {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Index() @Column({ name: 'full_name', length: 120 }) fullName!: string;
  @Column({ type: 'date' }) dob!: string;
  @Column({ type: 'char', length: 1 }) gender!: 'M' | 'F';
  @Index() @Column({ name: 'class_id', type: 'uuid', nullable: true }) classId!: string | null;
  @ManyToOne(() => ClassRoom, { onDelete: 'SET NULL' }) @JoinColumn({ name: 'class_id' }) classRoom!: ClassRoom | null;
  @Column({ type: 'text', nullable: true }) allergies!: string | null;
  @Column({ name: 'health_notes', type: 'text', nullable: true }) healthNotes!: string | null;
  @Column({ type: 'text', nullable: true }) address!: string | null;
  @Column({ name: 'photo_url', type: 'text', nullable: true }) photoUrl!: string | null;
  @Column({ name: 'enrolled_at', type: 'date', nullable: true }) enrolledAt!: string | null;
  @Column({ length: 20, default: 'active' }) status!: 'active' | 'left';
  @OneToMany(() => Guardian, (g) => g.child) guardians!: Guardian[];
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
}

@Entity('guardians')
export class Guardian {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Index() @Column({ name: 'child_id', type: 'uuid' }) childId!: string;
  @ManyToOne(() => Child, (c) => c.guardians, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'child_id' }) child!: Child;
  @Column({ name: 'full_name', length: 120 }) fullName!: string;
  @Column({ length: 40 }) relation!: string;
  @Column({ type: 'varchar', length: 20, nullable: true }) phone!: string | null;
  @Column({ name: 'id_number', type: 'varchar', length: 20, nullable: true }) idNumber!: string | null;
  @Column({ name: 'can_pickup', default: true }) canPickup!: boolean;
  @Index() @Column({ name: 'user_id', type: 'uuid', nullable: true }) userId!: string | null;
  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true }) @JoinColumn({ name: 'user_id' }) user!: User | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
}

@Entity('attendance')
@Unique('uq_attendance_child_date', ['childId', 'date'])
export class Attendance {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'child_id', type: 'uuid' }) childId!: string;
  @ManyToOne(() => Child, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'child_id' }) child!: Child;
  @Index() @Column({ name: 'class_id', type: 'uuid' }) classId!: string;
  @ManyToOne(() => ClassRoom, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'class_id' }) classRoom!: ClassRoom;
  @Index() @Column({ type: 'date' }) date!: string;
  @Column({ type: 'enum', enum: ['present', 'absent', 'late'], enumName: 'attendance_status' }) status!: AttStatus;
  @Column({ type: 'text', nullable: true }) note!: string | null;
  @Column({ name: 'recorded_by', type: 'uuid', nullable: true }) recordedBy!: string | null;
  @OneToOne(() => Pickup, (p) => p.attendance) pickup!: Pickup | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
}

@Entity('pickups')
export class Pickup {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Index({ unique: true }) @Column({ name: 'attendance_id', type: 'uuid' }) attendanceId!: string;
  @OneToOne(() => Attendance, (a) => a.pickup, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'attendance_id' }) attendance!: Attendance;
  @Column({ name: 'guardian_id', type: 'uuid', nullable: true }) guardianId!: string | null;
  @ManyToOne(() => Guardian, { onDelete: 'SET NULL', nullable: true }) @JoinColumn({ name: 'guardian_id' }) guardian!: Guardian | null;
  @Column({ name: 'picked_up_by_name', length: 120 }) pickedUpByName!: string;
  @Column({ type: 'varchar', length: 40, nullable: true }) relation!: string | null;
  @Column({ name: 'picked_up_at', type: 'timestamptz' }) pickedUpAt!: Date;
  @Column({ name: 'is_authorized' }) isAuthorized!: boolean;
  @Column({ type: 'text', nullable: true }) note!: string | null;
  @Column({ name: 'recorded_by', type: 'uuid', nullable: true }) recordedBy!: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
}

export const ENTITIES = [User, ClassRoom, ClassTeacher, Child, Guardian, Attendance, Pickup];
