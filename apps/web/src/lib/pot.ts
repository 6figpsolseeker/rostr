import "server-only";
import { potDepositGate } from "@rostr/escrow";
import { ClusterConfigError, declaredCluster } from "./cluster";

/**
 * Whether this deployment should invite a pot deposit.
 *
 * The rule itself is `potDepositGate` in `@rostr/escrow`, where it is tested and
 * where the native app can reach it too. This is the thin server-side binding:
 * which cluster we declare ourselves to be on.
 *
 * **Fails closed, and the catch is load-bearing.** `declaredCluster()` throws in
 * production when `SOLANA_CLUSTER` is unset, and this is called from
 * `/leagues/[id]` — one of the two pages deliberately left readable by people
 * who are not members, because `RULES.md` requires the full rule set to be shown
 * before anyone joins. Letting the throw escape would turn a missing environment
 * variable into a 500 on the league entrance for everyone, private and public
 * alike. A deployment that cannot say which chain it is on is exactly the one
 * that must not invite a buy-in, so answering "closed" is both the safe reading
 * and the honest one.
 */
export function depositsOpen(): boolean {
  try {
    return potDepositGate(declaredCluster()).open;
  } catch (error) {
    if (error instanceof ClusterConfigError) return false;
    throw error;
  }
}
