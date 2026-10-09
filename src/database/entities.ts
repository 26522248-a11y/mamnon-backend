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
  /** Set for admin-created accounts and after an admin password reset; cleared by change-password. */
  @Column({ name: 'must_change_password', default: false }) mustChangePassword!: boolean;
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
  @Column({ length: 20, default: 'active' }) status!: 'active' | 'withdrawn';
  /** Last day the child attends (withdrawal). Data is kept; child is excluded from new invoices and attendance after this date. */
  @Column({ name: 'leave_date', type: 'date', nullable: true }) leaveDate!: string | null;
  @Column({ name: 'withdrawal_reason', type: 'text', nullable: true }) withdrawalReason!: string | null;
  @Column({ name: 'withdrawn_at', type: 'timestamptz', nullable: true }) withdrawnAt!: Date | null;
  @Column({ name: 'withdrawn_by', type: 'uuid', nullable: true }) withdrawnBy!: string | null;
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
  /** Absence notified in advance by the family -> eligible for meal refund. */
  @Column({ name: 'notified_in_advance', default: false }) notifiedInAdvance!: boolean;
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
  @Column({ name: 'pickup_request_id', type: 'uuid', nullable: true }) pickupRequestId!: string | null;
  @Column({ type: 'text', nullable: true }) note!: string | null;
  @Column({ name: 'recorded_by', type: 'uuid', nullable: true }) recordedBy!: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
}


/** numeric columns come back from pg as strings; convert to number. */
const num = { to: (v?: number | null) => v, from: (v?: string | null) => (v === null || v === undefined ? null : Number(v)) };

// ───────────── Fees / debts ─────────────
export type FeeType = 'monthly' | 'one_time' | 'discount';
export type LineKind = 'charge' | 'discount' | 'refund' | 'credit';
export type FeeScope = 'school' | 'class' | 'child';
export type InvoiceStatus = 'unpaid' | 'partial' | 'paid' | 'void';

@Entity('fee_items')
export class FeeItem {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ length: 120 }) name!: string;
  @Column({ type: 'integer' }) amount!: number; // VND
  @Column({ type: 'varchar', length: 20, default: 'monthly' }) type!: FeeType;
  @Column({ type: 'varchar', length: 20, default: 'school' }) scope!: FeeScope;
  @Index() @Column({ name: 'class_id', type: 'uuid', nullable: true }) classId!: string | null;
  @ManyToOne(() => ClassRoom, { onDelete: 'CASCADE', nullable: true }) @JoinColumn({ name: 'class_id' }) classRoom!: ClassRoom | null;
  @Index() @Column({ name: 'child_id', type: 'uuid', nullable: true }) childId!: string | null;
  @ManyToOne(() => Child, { onDelete: 'CASCADE', nullable: true }) @JoinColumn({ name: 'child_id' }) child!: Child | null;
  @Column({ name: 'is_active', default: true }) isActive!: boolean;
  /** Required for type=discount (e.g. "Anh chị em ruột cùng học"). */
  @Column({ type: 'text', nullable: true }) reason!: string | null;
  /** On the meal fee item: refund per absent day notified in advance. */
  @Column({ name: 'meal_refund_per_day', type: 'integer', nullable: true }) mealRefundPerDay!: number | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
}

@Entity('invoices')
@Index('uq_invoice_child_period_live', ['childId', 'period'], { unique: true, where: `status <> 'void'` })
export class Invoice {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Index({ unique: true }) @Column({ name: 'invoice_no', length: 30 }) invoiceNo!: string;
  @Index() @Column({ name: 'child_id', type: 'uuid' }) childId!: string;
  @ManyToOne(() => Child, { onDelete: 'RESTRICT' }) @JoinColumn({ name: 'child_id' }) child!: Child;
  @Column({ name: 'class_id', type: 'uuid', nullable: true }) classId!: string | null; // snapshot at issue time
  @ManyToOne(() => ClassRoom, { onDelete: 'SET NULL', nullable: true }) @JoinColumn({ name: 'class_id' }) classRoom!: ClassRoom | null;
  @Index() @Column({ length: 7 }) period!: string; // YYYY-MM
  @Column({ name: 'issue_date', type: 'date' }) issueDate!: string;
  @Column({ name: 'due_date', type: 'date' }) dueDate!: string;
  @Column({ name: 'total_amount', type: 'integer' }) totalAmount!: number;
  @Column({ name: 'paid_amount', type: 'integer', default: 0 }) paidAmount!: number;
  @Index() @Column({ type: 'varchar', length: 10, default: 'unpaid' }) status!: InvoiceStatus;
  @Column({ type: 'text', nullable: true }) note!: string | null;
  @Column({ name: 'created_by', type: 'uuid', nullable: true }) createdBy!: string | null;
  @OneToMany(() => InvoiceLine, (l) => l.invoice, { cascade: true }) lines!: InvoiceLine[];
  @OneToMany(() => Payment, (p) => p.invoice) payments!: Payment[];
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
}

@Entity('invoice_lines')
export class InvoiceLine {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Index() @Column({ name: 'invoice_id', type: 'uuid' }) invoiceId!: string;
  @ManyToOne(() => Invoice, (i) => i.lines, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'invoice_id' }) invoice!: Invoice;
  @Column({ name: 'fee_item_id', type: 'uuid', nullable: true }) feeItemId!: string | null;
  @ManyToOne(() => FeeItem, { onDelete: 'SET NULL', nullable: true }) @JoinColumn({ name: 'fee_item_id' }) feeItem!: FeeItem | null;
  @Column({ length: 200 }) description!: string;
  @Column({ type: 'integer', default: 1 }) quantity!: number;
  @Column({ type: 'varchar', length: 10, default: 'charge' }) kind!: LineKind;
  @Column({ name: 'unit_price', type: 'integer' }) unitPrice!: number; // always >= 0
  /** Signed effective amount: + for charge, - for discount/refund/credit. */
  @Column({ type: 'integer' }) amount!: number;
  @Column({ type: 'text', nullable: true }) reason!: string | null;
}

@Entity('payments')
export class Payment {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Index({ unique: true }) @Column({ name: 'receipt_no', length: 30 }) receiptNo!: string;
  @Index() @Column({ name: 'invoice_id', type: 'uuid', nullable: true }) invoiceId!: string | null; // null = prepayment
  @ManyToOne(() => Invoice, (i) => i.payments, { onDelete: 'RESTRICT', nullable: true }) @JoinColumn({ name: 'invoice_id' }) invoice!: Invoice | null;
  @Index() @Column({ name: 'child_id', type: 'uuid' }) childId!: string;
  @ManyToOne(() => Child, { onDelete: 'RESTRICT' }) @JoinColumn({ name: 'child_id' }) child!: Child;
  /** Portion of this payment that went to the child's credit balance (prepayment / overpayment). */
  @Column({ name: 'credit_amount', type: 'integer', default: 0 }) creditAmount!: number;
  @Column({ type: 'integer' }) amount!: number;
  @Column({ type: 'varchar', length: 20 }) method!: 'cash' | 'transfer';
  @Column({ name: 'paid_at', type: 'timestamptz' }) paidAt!: Date;
  @Column({ name: 'payer_name', type: 'varchar', length: 120, nullable: true }) payerName!: string | null;
  @Column({ type: 'text', nullable: true }) note!: string | null;
  @Column({ name: 'received_by', type: 'uuid', nullable: true }) receivedBy!: string | null;
  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true }) @JoinColumn({ name: 'received_by' }) receiver!: User | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
}

// ───────────── Health & nutrition ─────────────
@Entity('growth_records')
@Unique('uq_growth_child_date', ['childId', 'date'])
export class GrowthRecord {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Index() @Column({ name: 'child_id', type: 'uuid' }) childId!: string;
  @ManyToOne(() => Child, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'child_id' }) child!: Child;
  @Column({ type: 'date' }) date!: string;
  @Column({ name: 'height_cm', type: 'numeric', precision: 5, scale: 1, nullable: true, transformer: num }) heightCm!: number | null;
  @Column({ name: 'weight_kg', type: 'numeric', precision: 5, scale: 2, nullable: true, transformer: num }) weightKg!: number | null;
  @Column({ type: 'text', nullable: true }) note!: string | null;
  @Column({ name: 'recorded_by', type: 'uuid', nullable: true }) recordedBy!: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
}

export type Meal = 'breakfast' | 'lunch' | 'snack';
@Entity('menus')
@Unique('uq_menu_date_meal', ['date', 'meal'])
export class MenuItem {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Index() @Column({ type: 'date' }) date!: string;
  @Column({ type: 'varchar', length: 20 }) meal!: Meal;
  @Column({ type: 'text' }) dishes!: string;
  @Column({ name: 'allergy_notes', type: 'text', nullable: true }) allergyNotes!: string | null;
  @Column({ name: 'updated_by', type: 'uuid', nullable: true }) updatedBy!: string | null;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
}

export type EatingLevel = 'all' | 'most' | 'half' | 'little' | 'none';
@Entity('daily_notes')
@Unique('uq_daily_note_child_date', ['childId', 'date'])
export class DailyNote {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'child_id', type: 'uuid' }) childId!: string;
  @ManyToOne(() => Child, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'child_id' }) child!: Child;
  @Index() @Column({ name: 'class_id', type: 'uuid' }) classId!: string;
  @ManyToOne(() => ClassRoom, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'class_id' }) classRoom!: ClassRoom;
  @Index() @Column({ type: 'date' }) date!: string;
  @Column({ type: 'varchar', length: 10, nullable: true }) eating!: EatingLevel | null;
  @Column({ name: 'sleep_minutes', type: 'integer', nullable: true }) sleepMinutes!: number | null;
  @Column({ type: 'varchar', length: 40, nullable: true }) mood!: string | null;
  @Column({ type: 'varchar', length: 40, nullable: true }) toilet!: string | null;
  @Column({ type: 'text', nullable: true }) note!: string | null;
  @Column({ name: 'recorded_by', type: 'uuid', nullable: true }) recordedBy!: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
}

// ───────────── Attendance audit & pickup requests ─────────────
@Entity('attendance_history')
export class AttendanceHistory {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Index() @Column({ name: 'attendance_id', type: 'uuid' }) attendanceId!: string;
  @ManyToOne(() => Attendance, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'attendance_id' }) attendance!: Attendance;
  @Column({ type: 'varchar', length: 10 }) action!: 'create' | 'update';
  @Column({ name: 'old_status', type: 'varchar', length: 10, nullable: true }) oldStatus!: AttStatus | null;
  @Column({ name: 'old_note', type: 'text', nullable: true }) oldNote!: string | null;
  @Column({ name: 'new_status', type: 'varchar', length: 10 }) newStatus!: AttStatus;
  @Column({ name: 'new_note', type: 'text', nullable: true }) newNote!: string | null;
  @Column({ name: 'old_notified', type: 'boolean', nullable: true }) oldNotified!: boolean | null;
  @Column({ name: 'new_notified', type: 'boolean', default: false }) newNotified!: boolean;
  @Column({ name: 'changed_by', type: 'uuid', nullable: true }) changedBy!: string | null;
  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true }) @JoinColumn({ name: 'changed_by' }) changer!: User | null;
  @CreateDateColumn({ name: 'changed_at', type: 'timestamptz' }) changedAt!: Date;
}

export type PickupRequestStatus = 'pending' | 'approved' | 'rejected' | 'expired';
@Entity('pickup_requests')
export class PickupRequest {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Index() @Column({ name: 'attendance_id', type: 'uuid' }) attendanceId!: string;
  @ManyToOne(() => Attendance, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'attendance_id' }) attendance!: Attendance;
  @Index() @Column({ name: 'child_id', type: 'uuid' }) childId!: string;
  @ManyToOne(() => Child, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'child_id' }) child!: Child;
  @Index() @Column({ name: 'class_id', type: 'uuid' }) classId!: string;
  @Column({ name: 'picker_name', length: 120 }) pickerName!: string;
  @Column({ name: 'picker_phone', length: 20 }) pickerPhone!: string;
  @Column({ type: 'varchar', length: 40, nullable: true }) relation!: string | null;
  @Column({ type: 'text', nullable: true }) note!: string | null;
  @Column({ name: 'photo_url', type: 'text', nullable: true }) photoUrl!: string | null;
  @Index() @Column({ type: 'varchar', length: 10, default: 'pending' }) status!: PickupRequestStatus;
  /** min(created + 2h, end of the school day) */
  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true }) expiresAt!: Date | null;
  @Column({ name: 'decided_on_behalf', default: false }) decidedOnBehalf!: boolean;
  @Column({ name: 'requested_by', type: 'uuid', nullable: true }) requestedBy!: string | null;
  @Column({ name: 'decided_by', type: 'uuid', nullable: true }) decidedBy!: string | null;
  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true }) @JoinColumn({ name: 'decided_by' }) decider!: User | null;
  @Column({ name: 'decided_at', type: 'timestamptz', nullable: true }) decidedAt!: Date | null;
  @Column({ name: 'decision_note', type: 'text', nullable: true }) decisionNote!: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
}

// ───────────── Announcements & notifications ─────────────
export type AnnouncementScope = 'school' | 'class';
/** 'specific' = only the parents listed in recipient_user_ids */
export type Audience = 'all' | 'parents' | 'staff' | 'specific';
@Entity('announcements')
export class Announcement {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ length: 200 }) title!: string;
  @Column({ type: 'text' }) body!: string;
  @Column({ type: 'varchar', length: 10 }) scope!: AnnouncementScope;
  @Index() @Column({ name: 'class_id', type: 'uuid', nullable: true }) classId!: string | null;
  @ManyToOne(() => ClassRoom, { onDelete: 'CASCADE', nullable: true }) @JoinColumn({ name: 'class_id' }) classRoom!: ClassRoom | null;
  @Column({ type: 'varchar', length: 10, default: 'all' }) audience!: Audience;
  @Column({ name: 'created_by', type: 'uuid', nullable: true }) createdBy!: string | null;
  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true }) @JoinColumn({ name: 'created_by' }) author!: User | null;
  @Index() @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @Column({ type: 'boolean', default: false }) important!: boolean;
  /** audience='specific': the chosen parent user ids */
  @Column({ name: 'recipient_user_ids', type: 'uuid', array: true, nullable: true }) recipientUserIds!: string[] | null;
  /** Recall (= DELETE): soft-deleted, derived inbox items hidden */
  @Index() @Column({ name: 'recalled_at', type: 'timestamptz', nullable: true }) recalledAt!: Date | null;
  @Column({ name: 'recalled_by', type: 'uuid', nullable: true }) recalledBy!: string | null;
  @Column({ name: 'recipient_count', type: 'integer', default: 0 }) recipientCount!: number;
}

export type NotificationType = 'announcement' | 'pickup_request' | 'pickup_decision' | 'invoice' | 'payment';
@Entity('notifications')
@Index('ix_notifications_user_read', ['userId', 'readAt'])
@Index('ix_notifications_announcement', ['announcementId'])
export class Notification {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Index() @Column({ name: 'user_id', type: 'uuid' }) userId!: string;
  @ManyToOne(() => User, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'user_id' }) user!: User;
  @Column({ type: 'varchar', length: 30 }) type!: NotificationType;
  @Column({ length: 200 }) title!: string;
  @Column({ type: 'text', nullable: true }) body!: string | null;
  @Column({ type: 'jsonb', nullable: true }) data!: Record<string, unknown> | null;
  @Column({ name: 'announcement_id', type: 'uuid', nullable: true }) announcementId!: string | null;
  @ManyToOne(() => Announcement, { onDelete: 'CASCADE', nullable: true }) @JoinColumn({ name: 'announcement_id' }) announcement!: Announcement | null;
  @Column({ name: 'read_at', type: 'timestamptz', nullable: true }) readAt!: Date | null;
  @Index() @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @Column({ type: 'boolean', default: false }) important!: boolean;
  /** set when the source announcement is recalled: hidden from inbox and unread counts */
  @Column({ name: 'hidden_at', type: 'timestamptz', nullable: true }) hiddenAt!: Date | null;
}

@Entity('credit_transactions')
export class CreditTransaction {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Index() @Column({ name: 'child_id', type: 'uuid' }) childId!: string;
  @ManyToOne(() => Child, { onDelete: 'RESTRICT' }) @JoinColumn({ name: 'child_id' }) child!: Child;
  /** + credit added (prepayment/overpayment/void restore), - credit applied to an invoice */
  @Column({ type: 'integer' }) amount!: number;
  @Column({ type: 'varchar', length: 20 }) type!: 'prepayment' | 'overpayment' | 'applied' | 'restored' | 'void_refund' | 'adjustment' | 'meal_refund' | 'meal_clawback' | 'payout';
  @Column({ name: 'payment_id', type: 'uuid', nullable: true }) paymentId!: string | null;
  @Column({ name: 'invoice_id', type: 'uuid', nullable: true }) invoiceId!: string | null;
  @Column({ type: 'text', nullable: true }) note!: string | null;
  @Column({ name: 'created_by', type: 'uuid', nullable: true }) createdBy!: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
}

/**
 * One row per refunded absence day, so the same day is never refunded twice (re-generation, catch-up)
 * and a later attendance correction can be clawed back exactly once.
 */
@Entity('meal_refunds')
@Index('uq_meal_refund_active', ['attendanceId'], { unique: true, where: 'reversed_by_line_id IS NULL AND reversed_by_credit_tx_id IS NULL' })
export class MealRefund {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'attendance_id', type: 'uuid' }) attendanceId!: string;
  @ManyToOne(() => Attendance, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'attendance_id' }) attendance!: Attendance;
  @Index() @Column({ name: 'child_id', type: 'uuid' }) childId!: string;
  /** Refunded on an invoice line, or (withdrawal settlement) straight into the credit balance via credit_tx_id. */
  @Index() @Column({ name: 'invoice_line_id', type: 'uuid', nullable: true }) invoiceLineId!: string | null;
  @ManyToOne(() => InvoiceLine, { onDelete: 'CASCADE', nullable: true }) @JoinColumn({ name: 'invoice_line_id' }) invoiceLine!: InvoiceLine | null;
  @Column({ name: 'credit_tx_id', type: 'uuid', nullable: true }) creditTxId!: string | null;
  @Column({ type: 'integer' }) amount!: number;
  @Column({ name: 'reversed_by_line_id', type: 'uuid', nullable: true }) reversedByLineId!: string | null;
  @Column({ name: 'reversed_by_credit_tx_id', type: 'uuid', nullable: true }) reversedByCreditTxId!: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
}

/** Audit trail for invoice changes (line edits, void, payments). */
@Entity('invoice_audit')
export class InvoiceAudit {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Index() @Column({ name: 'invoice_id', type: 'uuid' }) invoiceId!: string;
  @ManyToOne(() => Invoice, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'invoice_id' }) invoice!: Invoice;
  @Column({ type: 'varchar', length: 30 }) action!: 'line_added' | 'line_updated' | 'line_deleted' | 'voided' | 'credit_applied';
  @Column({ name: 'line_id', type: 'uuid', nullable: true }) lineId!: string | null;
  @Column({ name: 'old_value', type: 'jsonb', nullable: true }) oldValue!: any;
  @Column({ name: 'new_value', type: 'jsonb', nullable: true }) newValue!: any;
  @Column({ name: 'changed_by', type: 'uuid', nullable: true }) changedBy!: string | null;
  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true }) @JoinColumn({ name: 'changed_by' }) changer!: User | null;
  @CreateDateColumn({ name: 'changed_at', type: 'timestamptz' }) changedAt!: Date;
}

/** Phiếu chi: paying a withdrawn child's remaining credit balance back to the family (balance -> 0). */
@Entity('refund_payouts')
export class RefundPayout {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Index({ unique: true }) @Column({ name: 'voucher_no', length: 30 }) voucherNo!: string;
  @Index() @Column({ name: 'child_id', type: 'uuid' }) childId!: string;
  @ManyToOne(() => Child, { onDelete: 'RESTRICT' }) @JoinColumn({ name: 'child_id' }) child!: Child;
  @Column({ type: 'integer' }) amount!: number;
  @Column({ type: 'varchar', length: 20 }) method!: 'cash' | 'transfer';
  @Column({ name: 'paid_at', type: 'timestamptz' }) paidAt!: Date;
  @Column({ name: 'recipient_name', length: 120 }) recipientName!: string;
  @Column({ type: 'text', nullable: true }) note!: string | null;
  @Column({ name: 'credit_tx_id', type: 'uuid', nullable: true }) creditTxId!: string | null;
  @Column({ name: 'paid_by', type: 'uuid', nullable: true }) paidBy!: string | null;
  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true }) @JoinColumn({ name: 'paid_by' }) payer!: User | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
}

export const ENTITIES = [
  RefundPayout,
  MealRefund, InvoiceAudit,
  CreditTransaction,
  Announcement, Notification,
  AttendanceHistory, PickupRequest,
  User, ClassRoom, ClassTeacher, Child, Guardian, Attendance, Pickup,
  FeeItem, Invoice, InvoiceLine, Payment, GrowthRecord, MenuItem, DailyNote,
];
