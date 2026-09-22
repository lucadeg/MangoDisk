import { defineStore } from 'pinia';

import { LOG_DOMAINS, LOG_EVENTS } from '@/lib/models/telemetry';
import { PAGE_IDS } from '@/lib/models/application-shell';
import type { AppSettings } from '@/lib/models/settings';
import type { DiskInfo } from '@/lib/models/disk';
import type { PageId } from '@/lib/models/application-shell';
import { DiskService } from '@/lib/services/disk-service';
import { LanguageService } from '@/lib/services/language-service';
import { LoggerService } from '@/lib/services/logger-service';
import { PreferenceStorageService } from '@/lib/services/preference-storage-service';
import { ThemeService } from '@/lib/services/theme-service';
import { ByteSizeService } from '@/lib/services/byte-size-service';
import * as AppSettingsUtils from '@/lib/utils/app-settings';
import {
  normalizeError,
  parseCommandError,
  parseCommandErrorReason,
  type CommandErrorCode,
  type CommandErrorReason,
} from '@/lib/utils/error';

interface AppState {
  currentPage: PageId;
  disk: DiskInfo | null;
  disks: DiskInfo[];
  settings: AppSettings;
  errorCode: CommandErrorCode | null;
  errorReason: CommandErrorReason | null;
}

const diskRefreshByStore = new WeakMap<object, Promise<boolean>>();
const systemDiskRefreshByStore = new WeakMap<object, Promise<boolean>>();

export const useAppStore = defineStore('app', {
  state: (): AppState => ({
    currentPage: PAGE_IDS.cleanup,
    disk: null,
    disks: [],
    // Application startup loads platform-aware settings before Vue mounts. The
    // deterministic binary placeholder keeps isolated Store tests independent
    // from Tauri's window-scoped OS plugin.
    settings: AppSettingsUtils.defaults(LanguageService.detectSystemLanguage()),
    errorCode: null,
    errorReason: null,
  }),
  actions: {
    async initialize() {
      try {
        const [disk, disks] = await Promise.all([DiskService.getSystemDisk(), DiskService.listDisks()]);
        this.disk = disk;
        this.disks = disks;
      } catch (error) {
        this.reportError(error);
      }
    },
    navigate(page: PageId) {
      this.currentPage = page;
      this.errorCode = null;
      this.errorReason = null;
    },
    reportOperationBusy(reason: CommandErrorReason | null = null) {
      this.errorCode = 'operationBusy';
      this.errorReason = reason;
      LoggerService.info(LOG_DOMAINS.applicationShell, LOG_EVENTS.operationDeferred, {
        code: this.errorCode,
        reason,
      });
    },
    updateSystemDisk(disk: DiskInfo) {
      this.disk = disk;
      const index = this.disks.findIndex(item => item.mountPoint === disk.mountPoint);
      if (index >= 0) this.disks[index] = disk;
    },
    async refreshDisks(): Promise<boolean> {
      const pending = diskRefreshByStore.get(this);
      if (pending) return pending;
      const refresh = (async () => {
        try {
          const [disk, disks] = await Promise.all([DiskService.getSystemDisk(), DiskService.listDisks()]);
          this.disk = disk;
          this.disks = disks;
          return true;
        } catch (error) {
          // Live refresh is observational. Preserve the last coherent snapshot
          // rather than partially updating capacity or the volume inventory.
          LoggerService.warn(LOG_DOMAINS.applicationShell, LOG_EVENTS.diskRefreshFailed, {
            code: parseCommandError(error)?.code ?? 'operationFailed',
          });
          return false;
        }
      })().finally(() => diskRefreshByStore.delete(this));
      diskRefreshByStore.set(this, refresh);
      return refresh;
    },
    async refreshSystemDisk(): Promise<boolean> {
      const pending = systemDiskRefreshByStore.get(this);
      if (pending) return pending;
      const refresh = (async () => {
        try {
          this.updateSystemDisk(await DiskService.getSystemDisk());
          return true;
        } catch (error) {
          /*
           * Capacity is a secondary view after a completed filesystem mutation.
           * A refresh failure must not turn that completed operation into a user-
           * visible failure, but the typed error code is retained for diagnosis.
           */
          LoggerService.warn(LOG_DOMAINS.applicationShell, LOG_EVENTS.diskRefreshFailed, {
            code: parseCommandError(error)?.code ?? 'operationFailed',
          });
          return false;
        }
      })().finally(() => systemDiskRefreshByStore.delete(this));
      systemDiskRefreshByStore.set(this, refresh);
      return refresh;
    },
    reportError(error: unknown) {
      const commandError = parseCommandError(error);
      if (commandError?.code === 'operationBusy') {
        this.reportOperationBusy(parseCommandErrorReason(commandError));
        return;
      }
      this.errorCode = commandError?.code ?? 'operationFailed';
      this.errorReason = parseCommandErrorReason(commandError);
      LoggerService.error(LOG_DOMAINS.applicationShell, LOG_EVENTS.operationFailed, {
        code: this.errorCode,
        diagnostic: normalizeError(error),
      });
    },
    saveSettings(settings: AppSettings) {
      this.settings = AppSettingsUtils.parse(settings, ByteSizeService.currentUnitBase());
      void PreferenceStorageService.saveSettings(this.settings).catch(error => {
        LoggerService.warn(LOG_DOMAINS.settings, LOG_EVENTS.savedSettingsSaveFailed, {
          error,
        });
        this.reportError(error);
      });
      LanguageService.apply(this.settings.language);
      ThemeService.apply(this.settings.theme);
    },
    async loadSettings() {
      const unitBase = ByteSizeService.currentUnitBase();
      const defaults = AppSettingsUtils.defaults(LanguageService.detectSystemLanguage(), unitBase);
      let value: unknown | null;
      try {
        value = await PreferenceStorageService.loadSettings();
      } catch (error) {
        LoggerService.warn(LOG_DOMAINS.settings, LOG_EVENTS.savedSettingsLoadFailed, { error });
        this.settings = defaults;
        LanguageService.apply(this.settings.language);
        ThemeService.apply(this.settings.theme);
        return;
      }
      try {
        this.settings = value === null ? defaults : AppSettingsUtils.parse(value, unitBase);
      } catch (error) {
        LoggerService.warn(LOG_DOMAINS.settings, LOG_EVENTS.savedSettingsInvalid, {
          error,
        });
        try {
          await PreferenceStorageService.clearSettings();
        } catch (clearError) {
          LoggerService.warn(LOG_DOMAINS.settings, LOG_EVENTS.savedSettingsClearFailed, { error: clearError });
        }
        this.settings = defaults;
      }
      LanguageService.apply(this.settings.language);
      ThemeService.apply(this.settings.theme);
    },
    clearError() {
      this.errorCode = null;
      this.errorReason = null;
    },
  },
});
