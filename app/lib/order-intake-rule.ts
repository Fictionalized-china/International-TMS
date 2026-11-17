import { defaultBusinessProcessPolicy, type BusinessProcessPolicy } from "./business-process-policy";
import { currentIntakeRuleVersion,knownIntakeRequirements } from "./order-intake-completeness";

export {currentIntakeRuleVersion} from "./order-intake-completeness";
export const intakeRulePolicyKeys = ["order.ltl_required_fees", "order.ftl_required_fees", "order.require_receivable", "order.ftl_require_payable"] as const;
export const currentIntakeRequiredKeys = [...knownIntakeRequirements.map(field => field.fieldKey), "quotation_intake_businessMajor", "quotation_intake_businessKind"];
export type IntakeRuleBinding = { version: typeof currentIntakeRuleVersion; requiredKeys: string[]; feePolicy: Record<typeof intakeRulePolicyKeys[number], string> };
export function createIntakeRuleBinding(policy: BusinessProcessPolicy): IntakeRuleBinding {
  return { version: currentIntakeRuleVersion, requiredKeys: [...currentIntakeRequiredKeys], feePolicy: Object.fromEntries(intakeRulePolicyKeys.map(key => [key, policy[key]])) as IntakeRuleBinding["feePolicy"] };
}
/** Rule configuration only; never trusts a rule version submitted by the browser. */
export function readIntakeRuleBinding(raw: unknown): IntakeRuleBinding | null {
  if(raw==null||raw==="")return null;
  let root:unknown;
  try{root=typeof raw==="string"?JSON.parse(raw):null;}catch{throw new Error("本单录单资料或检查规则损坏，请补录核对后由管理员修复规则，不能跳过检查");}
  if(!root||typeof root!=="object"||Array.isArray(root))throw new Error("本单录单资料或检查规则损坏，不能跳过检查");
  if(!Object.hasOwn(root,"intakeRule"))return null;
  const candidate = (root as Record<string,unknown>).intakeRule;
  if(candidate==null)throw new Error("本单录单检查规则损坏，不能跳过检查");
  if (typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("本单录单检查规则损坏，请由管理员核对，不能跳过检查");
  const value = candidate as Partial<IntakeRuleBinding>;
  if (value.version !== currentIntakeRuleVersion || !Array.isArray(value.requiredKeys) || value.requiredKeys.length !== currentIntakeRequiredKeys.length || currentIntakeRequiredKeys.some(key => !value.requiredKeys!.includes(key)) || !value.feePolicy || intakeRulePolicyKeys.some(key => typeof value.feePolicy![key] !== "string")) throw new Error("本单录单检查规则版本无效，请核对规则绑定");
  return value as IntakeRuleBinding;
}
/** Read-only screens must remain available to investigate and correct damage. */
export function inspectIntakeRuleBinding(raw:unknown){
  try{return{binding:readIntakeRuleBinding(raw),error:null};}
  catch(error){return{binding:null,error:error instanceof Error?error.message:"录单检查规则损坏"};}
}
export function boundIntakePolicy(binding: IntakeRuleBinding): BusinessProcessPolicy {
  return { ...defaultBusinessProcessPolicy, ...binding.feePolicy };
}
