import { parseAbi } from "viem";

/** AuraPay Savings Vault (contracts/src/AuraPaySavingsVault.sol): time-locked savings on Polygon. */
export const SAVINGS_VAULT_ABI = parseAbi([
  "function lock(address token, uint256 amount, uint64 unlockAt) returns (uint256 id)",
  "function release(uint256 id)",
  "function getLock(uint256 id) view returns ((address owner, address token, uint128 amount, uint64 unlockAt, bool released))",
  "function lockCount() view returns (uint256)",
  "event Locked(uint256 indexed id, address indexed owner, address indexed token, uint256 amount, uint64 unlockAt)",
  "event Released(uint256 indexed id, address indexed owner, address indexed token, uint256 amount, address caller)",
]);

/** Shortest and longest lock the app offers (the contract allows up to 10 years). */
export const MIN_LOCK_SECONDS = 10 * 60;
export const MAX_LOCK_SECONDS = 5 * 365 * 24 * 3600;

export type SavingsLockStatus = "pending" | "locked" | "released" | "failed";

export interface SavingsLockDTO {
  id: string;
  ref: string;
  label: string | null;
  amount: number | null;
  unlockAt: string | null;
  status: SavingsLockStatus;
  /** True once the unlock time has passed (the lock can be released). */
  unlocked: boolean;
  lockId: string | null;
  ownerAddress: string;
  lockTxHash: string;
  releaseTxHash: string | null;
  releasedBy: "owner" | "auto" | "other" | null;
  failureReason: string | null;
  createdAt: string;
  releasedAt: string | null;
}

export interface SavingsInfo {
  enabled: boolean;
  reason: string | null;
  vaultAddress: string | null;
  /** AuraPay releases matured locks automatically (a gas-only relayer is configured). */
  autoRelease: boolean;
}
