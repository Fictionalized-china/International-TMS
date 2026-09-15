const transitions = {
  quote: { draft: ["sent", "cancelled"], sent: ["accepted", "rejected", "expired", "cancelled"], accepted: [], rejected: [], expired: [], cancelled: [] },
  order: { draft: ["submitted", "confirmed", "cancelled"], submitted: ["confirmed", "cancelled"], confirmed: ["in_execution", "cancelled"], in_execution: ["completed", "cancelled"], completed: [], cancelled: [] },
  shipment: { booked: ["picked_up", "cancelled"], picked_up: ["in_transit", "exception"], in_transit: ["customs", "delivered", "exception"], customs: ["in_transit", "delivered", "exception"], exception: ["in_transit", "cancelled"], delivered: [], cancelled: [] },
  invoice: { draft: ["issued", "void"], issued: ["partially_paid", "paid", "overdue", "void"], partially_paid: ["paid", "overdue", "void"], overdue: ["partially_paid", "paid", "void"], paid: [], void: [] },
} as const;

export type WorkflowType = keyof typeof transitions;

export function canTransition(type: WorkflowType, from: string, to: string): boolean {
  const states = transitions[type] as Record<string, readonly string[]>;
  return Boolean(states[from]?.includes(to));
}

export function nextStates(type: WorkflowType, from: string): readonly string[] {
  const states = transitions[type] as Record<string, readonly string[]>;
  return states[from] ?? [];
}
