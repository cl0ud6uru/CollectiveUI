export type GroupSelection = { picked: string[]; leadId: string | null };
export type GroupSelectionAction =
  | { type: "toggle"; id: string }
  | { type: "lead"; id: string }
  | { type: "reset" };

export const emptyGroupSelection: GroupSelection = { picked: [], leadId: null };

/** Membership and lead are separate choices; removing the lead requires a new choice. */
export function groupSelectionReducer(state: GroupSelection, action: GroupSelectionAction): GroupSelection {
  switch (action.type) {
    case "reset": return emptyGroupSelection;
    case "lead": return state.picked.includes(action.id) ? { ...state, leadId: action.id } : state;
    case "toggle": {
      if (state.picked.includes(action.id)) {
        return { picked: state.picked.filter(id => id !== action.id), leadId: state.leadId === action.id ? null : state.leadId };
      }
      return state.picked.length < 6 ? { ...state, picked: [...state.picked, action.id] } : state;
    }
  }
}

/** The existing group API stores the lead in position zero. */
export function groupMemberOrder({ picked, leadId }: GroupSelection): string[] | null {
  if (picked.length < 2 || picked.length > 6 || !leadId || !picked.includes(leadId)) return null;
  return [leadId, ...picked.filter(id => id !== leadId)];
}
