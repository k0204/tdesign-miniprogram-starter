import { EDIT_TYPES, ANCHOR_PHOTO, CONSTRAINT_TAIL, buildPrompt } from './promptOptions';

export const CAPABILITIES = EDIT_TYPES;

export function findCapability(id) {
  return CAPABILITIES.find((item) => item.id === id) || null;
}

export function findOption(id) {
  for (let i = 0; i < CAPABILITIES.length; i += 1) {
    const option = CAPABILITIES[i].options.find((item) => item.id === id);
    if (option) return { capability: CAPABILITIES[i], option };
  }
  return null;
}

export function buildEditPrompt({ option, capability, extra = '', reference = '' } = {}) {
  return buildPrompt({
    item: option,
    keepHint: capability && capability.keepHint,
    extra,
    reference,
  });
}

export { ANCHOR_PHOTO, CONSTRAINT_TAIL };
