/** One intake registry; order columns remain the downstream source of truth. */
export const intakeRouteFields = [
  { fieldKey: "quotation_exit_port", column: "exit_port", formName: "exitPort", label: "出境口岸", category: "border_port", maxLength: 200 },
  { fieldKey: "quotation_transit_locations", column: "transit_locations", formName: "transitLocations", label: "中转地", category: "transit_place", maxLength: 200 },
  { fieldKey: "quotation_customs_location", column: "customs_location", formName: "customsLocation", label: "清关地", category: "customs_place", maxLength: 200 },
  { fieldKey: "quotation_domestic_agent", column: "domestic_agent", formName: "domesticAgent", label: "国内代理", category: null, maxLength: 200 },
] as const;

export type IntakeRouteValues = Record<(typeof intakeRouteFields)[number]["column"], string | null>;
export type IntakeRouteReference = { category: string; code: string; name: string };
export type IntakeFieldPolicy = { isActive: boolean; isRequired: boolean };
