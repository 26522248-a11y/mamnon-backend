import { PickupRequest, PickupRequestStatus, StepStatus } from '../database/entities';

export const isExpired = (r: PickupRequest) => r.status === 'expired' || (!!r.expiresAt && r.expiresAt.getTime() <= Date.now());
/** Why a request cannot be handed over (empty = it can, by someone other than the school approver). */
export const requestBlockers = (r: PickupRequest) => {
  const b: string[] = [];
  if (isExpired(r)) b.push('EXPIRED');
  if (r.parentStatus === 'rejected' || r.schoolStatus === 'rejected') b.push('REJECTED');
  if (r.parentStatus === 'pending') b.push('PARENT_PENDING');
  if (r.schoolStatus === 'pending') b.push('SCHOOL_PENDING');
  return b;
};
export const overallStatus = (parent: StepStatus, school: StepStatus): PickupRequestStatus =>
  parent === 'rejected' || school === 'rejected' ? 'rejected' : parent === 'approved' && school === 'approved' ? 'approved' : 'pending';

