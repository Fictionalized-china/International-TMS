import { isBossBusinessActor } from "./permission-blocks";

export type IntakeSalespersonOption = {
  id: string;
  position_code?: string | null;
};

/**
 * A boss may enter a quotation on behalf of the business team, but the order
 * should still start with a real salesperson responsibility by default.
 */
export function preferredIntakeSalespersonId(input: {
  currentUserId: string;
  currentPositionCode?: string | null;
  currentRoleCodes?: readonly string[];
  users: readonly IntakeSalespersonOption[];
}) {
  if (!isBossBusinessActor({
    positionCode: input.currentPositionCode,
    roleCodes: input.currentRoleCodes,
  })) return input.currentUserId;
  return input.users.find((user) => user.position_code === "SALES")?.id ?? input.currentUserId;
}
