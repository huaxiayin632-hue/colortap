import { ref, watch } from 'vue';

export const textureBudgetKey = 'rhythm-canvas.texture-budget.v1';
export const textureBudgets = [192, 256, 512, 1024, 2048] as const;
export function readTextureBudget(raw: string | null): number {
  const value = Number(raw);
  return textureBudgets.some((b) => b === value) ? value : 192;
}
let initial = 192;
try {
  initial = readTextureBudget(localStorage.getItem(textureBudgetKey));
} catch {
  /* Optional preference. */
}
export const textureBudgetMiB = ref(initial);
watch(textureBudgetMiB, (value) => {
  try {
    localStorage.setItem(textureBudgetKey, String(value));
  } catch {
    /* Keep the session choice. */
  }
});
