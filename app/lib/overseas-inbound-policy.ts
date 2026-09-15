import { runtimeWorkflowFieldPolicy, type RuntimeWorkflowFieldLike } from "./workflow-field-runtime";

export type OverseasInboundCustomsPolicyInput = {
  customsClearanceMode: "company" | "customer";
  moduleEnabled: boolean;
  moduleRequired: boolean;
  fields: readonly RuntimeWorkflowFieldLike[];
};

/**
 * Destination-clearance evidence is a configurable workflow gate.  Customer
 * clearance never blocks the warehouse, while company clearance only blocks
 * when both the customs module and its release field are required by the
 * order's bound workflow snapshot.
 *
 * The physical "already exited China" check intentionally lives outside this
 * helper: event ordering is an integrity invariant rather than a configurable
 * form requirement.
 */
export function overseasInboundRequiresCustomsClearance(
  input: OverseasInboundCustomsPolicyInput,
) {
  if (input.customsClearanceMode === "customer") return false;
  if (!input.moduleEnabled || !input.moduleRequired) return false;
  const release = runtimeWorkflowFieldPolicy(
    input.fields,
    "customs_release",
    true,
  );
  return release.visible && release.required;
}
