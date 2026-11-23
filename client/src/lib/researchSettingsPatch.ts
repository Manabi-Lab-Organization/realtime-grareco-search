import type { AutoGrarecoSettings } from 'shared';

interface SettingsWithAutoGrareco {
  autoGrareco: AutoGrarecoSettings;
}

export type SettingsPatch<T extends SettingsWithAutoGrareco> = Partial<Omit<T, 'autoGrareco'>> & {
  autoGrareco?: Partial<AutoGrarecoSettings>;
};

export type ResearchSettingsPatch = SettingsPatch<{
  main: boolean;
  web: boolean;
  fact: boolean;
  gap: boolean;
  tech: boolean;
  autoGrareco: AutoGrarecoSettings;
}>;

export function applyResearchSettingsPatch<T extends SettingsWithAutoGrareco>(prev: T, patch: SettingsPatch<T>): T {
  const { autoGrareco, ...rest } = patch;
  return {
    ...prev,
    ...rest,
    autoGrareco: autoGrareco ? { ...prev.autoGrareco, ...autoGrareco } : prev.autoGrareco,
  };
}
