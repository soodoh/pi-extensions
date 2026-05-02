export const WORKFLOW_TEXT_FIELD_MAX_LENGTH = 4000;

export function truncateWorkflowText(
	value: string | undefined,
): string | undefined {
	if (value === undefined) return undefined;
	if (value.length <= WORKFLOW_TEXT_FIELD_MAX_LENGTH) return value;
	return value.slice(0, WORKFLOW_TEXT_FIELD_MAX_LENGTH);
}
