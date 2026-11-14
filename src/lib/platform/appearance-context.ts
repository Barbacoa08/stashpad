import { createContext } from 'svelte';
import type { AppearancePreference } from './appearance';

type AppearanceContext = {
  readonly preference: AppearancePreference;
  setPreference: (preference: AppearancePreference) => void;
};

export const [getAppearance, provideAppearance] =
  createContext<AppearanceContext>();
