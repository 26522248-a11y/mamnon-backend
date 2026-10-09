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
  /** Parent-set contact phones for pickup calls (15-minute rule), in calling order. Null = fall back to guardian phones. */
  @Column({ name: 'contact_phone1', type: 'varchar', length: 20, nullable: true }) contactPhone1!: string | null;
  @Column({ name: 'contact_phone2', type: 'varchar', length: 20, nullable: true }) contactPhone2!: string | null;
  @Column({ name: 'contact_phones_updated_by', type: 'uuid', nullable: true }) contactPhonesUpdatedBy!: string | null;
  @Column({ name: 'contact_phones_updated_at', type: 'timestamptz', nullable: true }) contactPhonesUpdatedAt!: Date | null;
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
  /** registered & approved person who picked up (người đón hộ) */
  @Column({ name: 'authorized_picker_id', type: 'uuid', nullable: true }) authorizedPickerId!: string | null;
  /** 'guardian' | 'authorized_picker' | 'request' */
  @Column({ name: 'picker_kind', type: 'varchar', length: 20, nullable: true }) pickerKind!: string | null;
  @Index() @Column({ name: 'picker_phone', type: 'varchar', length: 20, nullable: true }) pickerPhone!: string | null;
  @Index() @Column({ name: 'picker_id_number', type: 'varchar', length: 20, nullable: true }) pickerIdNumber!: string | null;
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
  /** CCCD of the off-list person (optional, 12 digits) */
  @Column({ name: 'picker_id_number', type: 'varchar', length: 20, nullable: true }) pickerIdNumber!: string | null;
  // two-step approval (PM): BOTH the parent and the school (admin or the day's duty account) must approve before handover
  @Column({ name: 'parent_status', type: 'varchar', length: 10, default: 'pending' }) parentStatus!: StepStatus;
  @Column({ name: 'parent_decided_by', type: 'uuid', nullable: true }) parentDecidedBy!: string | null;
  @Column({ name: 'parent_decided_at', type: 'timestamptz', nullable: true }) parentDecidedAt!: Date | null;
  @Column({ name: 'parent_note', type: 'text', nullable: true }) parentNote!: string | null;
  /** 'app' | 'push' | 'on_behalf' (admin recorded the parent's answer after a phone call) */
  @Column({ name: 'parent_channel', type: 'varchar', length: 12, nullable: true }) parentChannel!: string | null;
  @Column({ name: 'school_status', type: 'varchar', length: 10, default: 'pending' }) schoolStatus!: StepStatus;
  @Column({ name: 'school_decided_by', type: 'uuid', nullable: true }) schoolDecidedBy!: string | null;
  @Column({ name: 'school_decided_at', type: 'timestamptz', nullable: true }) schoolDecidedAt!: Date | null;
  @Column({ name: 'school_note', type: 'text', nullable: true }) schoolNote!: string | null;
  /** 'admin' | 'duty' */
  @Column({ name: 'school_decided_role', type: 'varchar', length: 10, nullable: true }) schoolDecidedRole!: string | null;
}
export type StepStatus = 'pending' | 'approved' | 'rejected';

/** Person registered by a parent to pick the child up (người đón hộ). Only status=approved (by admin) counts as on-list. */
@Entity('authorized_pickers')
export class AuthorizedPicker {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Index() @Column({ name: 'child_id', type: 'uuid' }) childId!: string;
  @ManyToOne(() => Child, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'child_id' }) child!: Child;
  @Column({ name: 'full_name', length: 120 }) fullName!: string;
  @Column({ length: 40 }) relation!: string;
  @Column({ name: 'photo_url', type: 'text' }) photoUrl!: string;
  /** CCCD (12 digits). Sensitive: masked in every list; full value only via the audited identity endpoint. */
  @Index() @Column({ name: 'id_number', length: 20 }) idNumber!: string;
  @Index() @Column({ length: 20 }) phone1!: string;
  @Column({ type: 'varchar', length: 20, nullable: true }) phone2!: string | null;
  @Index() @Column({ type: 'varchar', length: 10, default: 'pending' }) status!: StepStatus;
  @Column({ name: 'decided_by', type: 'uuid', nullable: true }) decidedBy!: string | null;
  @Column({ name: 'decided_at', type: 'timestamptz', nullable: true }) decidedAt!: Date | null;
  @Column({ name: 'decision_note', type: 'text', nullable: true }) decisionNote!: string | null;
  @Column({ name: 'created_by', type: 'uuid', nullable: true }) createdBy!: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
  /** soft delete (history is kept) */
  @Index() @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true }) deletedAt!: Date | null;
  @Column({ name: 'deleted_by', type: 'uuid', nullable: true }) deletedBy!: string | null;
}

@Entity('authorized_picker_history')
export class AuthorizedPickerHistory {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Index() @Column({ name: 'picker_id', type: 'uuid' }) pickerId!: string;
  @ManyToOne(() => AuthorizedPicker, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'picker_id' }) picker!: AuthorizedPicker;
  /** create | update | delete | approve | reject */
  @Column({ length: 10 }) action!: string;
  /** changed fields; CCCD values are stored masked */
  @Column({ type: 'jsonb', nullable: true }) changes!: Record<string, unknown> | null;
  @Column({ name: 'changed_by', type: 'uuid', nullable: true }) changedBy!: string | null;
  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true }) @JoinColumn({ name: 'changed_by' }) changer!: User | null;
  @CreateDateColumn({ name: 'changed_at', type: 'timestamptz' }) changedAt!: Date;
}

/** History of the child's pickup contact phones (who changed what, when). */
@Entity('child_contact_history')
export class ChildContactHistory {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Index() @Column({ name: 'child_id', type: 'uuid' }) childId!: string;
  @ManyToOne(() => Child, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'child_id' }) child!: Child;
  @Column({ type: 'jsonb' }) before!: { phone1: string | null; phone2: string | null };
  @Column({ type: 'jsonb' }) after!: { phone1: string | null; phone2: string | null };
  @Column({ name: 'changed_by', type: 'uuid', nullable: true }) changedBy!: string | null;
  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true }) @JoinColumn({ name: 'changed_by' }) changer!: User | null;
  @CreateDateColumn({ name: 'changed_at', type: 'timestamptz' }) changedAt!: Date;
}

/** Every view of a full CCCD number (who, what, when, from where). */
@Entity('sensitive_access_logs')
export class SensitiveAccessLog {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Index() @Column({ name: 'user_id', type: 'uuid', nullable: true }) userId!: string | null;
  @Column({ name: 'user_role', type: 'varchar', length: 20 }) userRole!: string;
  /** 'authorized_picker' | 'pickup_request' | 'guardian' */
  @Column({ name: 'entity_type', type: 'varchar', length: 30 }) entityType!: string;
  @Index() @Column({ name: 'entity_id', type: 'uuid' }) entityId!: string;
  @Column({ name: 'child_id', type: 'uuid', nullable: true }) childId!: string | null;
  @Column({ type: 'varchar', length: 30 }) field!: string;
  @Column({ type: 'varchar', length: 30 }) purpose!: string;
  @Column({ name: 'attendance_id', type: 'uuid', nullable: true }) attendanceId!: string | null;
  @Column({ type: 'varchar', length: 64, nullable: true }) ip!: string | null;
  @Index() @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
}

/** 'trực đón': user allowed to give the school approval of off-list pickup requests on that date. */
@Entity('pickup_duties')
@Index('uq_pickup_duty', ['date', 'userId'], { unique: true })
export class PickupDuty {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Index() @Column({ type: 'date' }) date!: string;
  @Column({ name: 'user_id', type: 'uuid' }) userId!: string;
  @ManyToOne(() => User, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'user_id' }) user!: User;
  @Column({ name: 'assigned_by', type: 'uuid', nullable: true }) assignedBy!: string | null;
  @Column({ type: 'text', nullable: true }) note!: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
}

/** Teacher phone calls to the parent when a request has no answer after 15 minutes. Logging never changes the request. */
@Entity('pickup_call_attempts')
export class PickupCallAttempt {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Index() @Column({ name: 'pickup_request_id', type: 'uuid' }) pickupRequestId!: string;
  @ManyToOne(() => PickupRequest, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'pickup_request_id' }) request!: PickupRequest;
  @Column({ name: 'called_by', type: 'uuid', nullable: true }) calledBy!: string | null;
  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true }) @JoinColumn({ name: 'called_by' }) caller!: User | null;
  @Column({ name: 'guardian_id', type: 'uuid', nullable: true }) guardianId!: string | null;
  @Column({ length: 20 }) phone!: string;
  /** no_answer | busy | wrong_number | confirmed | rejected | other */
  @Column({ type: 'varchar', length: 20 }) outcome!: string;
  @Column({ type: 'text', nullable: true }) note!: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
}

@Entity('push_subscriptions')
export class PushSubscription {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Index() @Column({ name: 'user_id', type: 'uuid' }) userId!: string;
  @ManyToOne(() => User, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'user_id' }) user!: User;
  @Index({ unique: true }) @Column({ type: 'text' }) endpoint!: string;
  @Column({ type: 'text' }) p256dh!: string;
  @Column({ type: 'text' }) auth!: string;
  @Column({ name: 'user_agent', type: 'varchar', length: 300, nullable: true }) userAgent!: string | null;
  @Column({ name: 'last_success_at', type: 'timestamptz', nullable: true }) lastSuccessAt!: Date | null;
  @Column({ name: 'last_error', type: 'text', nullable: true }) lastError!: string | null;
  @Column({ name: 'fail_count', type: 'int', default: 0 }) failCount!: number;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
}

/** One row per channel delivery attempt (inapp / webpush / sms / zalo). */
@Entity('notification_deliveries')
export class NotificationDelivery {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'varchar', length: 12 }) channel!: string;
  @Index() @Column({ name: 'user_id', type: 'uuid', nullable: true }) userId!: string | null;
  @Column({ type: 'varchar', length: 30 }) type!: string;
  @Index() @Column({ name: 'ref_id', type: 'uuid', nullable: true }) refId!: string | null;
  /** sent | failed | skipped */
  @Column({ type: 'varchar', length: 10 }) status!: string;
  @Column({ type: 'text', nullable: true }) error!: string | null;
  @Index() @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
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

export type NotificationType = 'announcement' | 'pickup_request' | 'pickup_decision' | 'invoice' | 'payment' | 'picked_up' | 'picker_registration' | 'picker_decision' | 'contact_change';
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

/**
 * Generic audit trail for sensitive actions (guardian unlink, contact phone edits, CCCD views, authorized-picker decisions,
 * duty roster, on-behalf decisions…). Written together with logs/audit.jsonl (secondary copy).
 */
@Entity('audit_events')
@Index('ix_audit_events_child_created', ['childId', 'createdAt'])
@Index('ix_audit_events_action_created', ['action', 'createdAt'])
@Index('ix_audit_events_actor_created', ['actorId', 'createdAt'])
export class AuditEvent {
  @PrimaryGeneratedColumn('uuid') id!: string;
  /** no FK: kept even if the user is deleted; actorUsername / actorRole are snapshots */
  @Column({ name: 'actor_id', type: 'uuid', nullable: true }) actorId!: string | null;
  @Column({ name: 'actor_username', type: 'varchar', length: 60, nullable: true }) actorUsername!: string | null;
  @Column({ name: 'actor_role', type: 'varchar', length: 20, nullable: true }) actorRole!: string | null;
  @Column({ length: 60 }) action!: string;
  @Column({ name: 'entity_type', type: 'varchar', length: 40 }) entityType!: string;
  @Column({ name: 'entity_id', type: 'varchar', length: 64, nullable: true }) entityId!: string | null;
  @Column({ name: 'child_id', type: 'uuid', nullable: true }) childId!: string | null;
  @Column({ type: 'jsonb', nullable: true }) before!: Record<string, unknown> | null;
  @Column({ type: 'jsonb', nullable: true }) after!: Record<string, unknown> | null;
  @Column({ type: 'text', nullable: true }) reason!: string | null;
  @Column({ type: 'varchar', length: 64, nullable: true }) ip!: string | null;
  /** other context (account info, dates…) */
  @Column({ type: 'jsonb', nullable: true }) data!: Record<string, unknown> | null;
  /** api | backfill_jsonl | backfill_sensitive_log */
  @Column({ type: 'varchar', length: 30, default: 'api' }) source!: string;
  /** idempotent backfill key (sha256 of the jsonl line / sensitive_access_logs id) */
  @Index('uq_audit_events_dedupe', { unique: true }) @Column({ name: 'dedupe_key', type: 'varchar', length: 80, nullable: true }) dedupeKey!: string | null;
  @Index() @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
}

export const ENTITIES = [
  AuthorizedPicker, AuthorizedPickerHistory, ChildContactHistory, AuditEvent, SensitiveAccessLog, PickupDuty, PickupCallAttempt, PushSubscription, NotificationDelivery,
  RefundPayout,
  MealRefund, InvoiceAudit,
  CreditTransaction,
  Announcement, Notification,
  AttendanceHistory, PickupRequest,
  User, ClassRoom, ClassTeacher, Child, Guardian, Attendance, Pickup,
  FeeItem, Invoice, InvoiceLine, Payment, GrowthRecord, MenuItem, DailyNote,
];
