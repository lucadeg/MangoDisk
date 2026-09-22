import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DiskInfo } from '@/lib/models/disk';
import { LOG_DOMAINS, LOG_EVENTS } from '@/lib/models/telemetry';
import { DiskService } from '@/lib/services/disk-service';
import { LoggerService } from '@/lib/services/logger-service';

import { useAppStore } from './app-store';

const currentDisk: DiskInfo = {
  name: 'System',
  mountPoint: '/',
  totalBytes: 1_000,
  availableBytes: 400,
  usedBytes: 600,
};

describe('app store disk refresh', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it('publishes a fresh system disk snapshot across shared disk state', async () => {
    const refreshedDisk: DiskInfo = {
      ...currentDisk,
      availableBytes: 650,
      usedBytes: 350,
    };
    vi.spyOn(DiskService, 'getSystemDisk').mockResolvedValue(refreshedDisk);
    const store = useAppStore();
    store.disk = currentDisk;
    store.disks = [currentDisk, { ...currentDisk, name: 'External', mountPoint: '/Volumes/External' }];

    await expect(store.refreshSystemDisk()).resolves.toBe(true);

    expect(store.disk).toEqual(refreshedDisk);
    expect(store.disks).toEqual([refreshedDisk, { ...currentDisk, name: 'External', mountPoint: '/Volumes/External' }]);
  });

  it('requests a new native snapshot for every refresh', async () => {
    const firstSnapshot = { ...currentDisk, availableBytes: 450, usedBytes: 550 };
    const secondSnapshot = { ...currentDisk, availableBytes: 700, usedBytes: 300 };
    const getSystemDisk = vi
      .spyOn(DiskService, 'getSystemDisk')
      .mockResolvedValueOnce(firstSnapshot)
      .mockResolvedValueOnce(secondSnapshot);
    const store = useAppStore();

    await store.refreshSystemDisk();
    expect(store.disk).toEqual(firstSnapshot);

    await store.refreshSystemDisk();
    expect(store.disk).toEqual(secondSnapshot);
    expect(getSystemDisk).toHaveBeenCalledTimes(2);
  });

  it('keeps the previous snapshot when a secondary refresh fails', async () => {
    vi.spyOn(DiskService, 'getSystemDisk').mockRejectedValue(new Error('disk refresh failed'));
    const warn = vi.spyOn(LoggerService, 'warn').mockImplementation(() => undefined);
    const store = useAppStore();
    store.disk = currentDisk;

    await expect(store.refreshSystemDisk()).resolves.toBe(false);

    expect(store.disk).toEqual(currentDisk);
    expect(warn).toHaveBeenCalledWith(LOG_DOMAINS.applicationShell, LOG_EVENTS.diskRefreshFailed, {
      code: 'operationFailed',
    });
  });
  it('refreshes system capacity and the complete disk inventory together', async () => {
    const refreshedDisk = { ...currentDisk, availableBytes: 750, usedBytes: 250 };
    const externalDisk = { ...currentDisk, name: 'External', mountPoint: '/Volumes/External' };
    vi.spyOn(DiskService, 'getSystemDisk').mockResolvedValue(refreshedDisk);
    vi.spyOn(DiskService, 'listDisks').mockResolvedValue([refreshedDisk, externalDisk]);
    const store = useAppStore();

    await expect(store.refreshDisks()).resolves.toBe(true);

    expect(store.disk).toEqual(refreshedDisk);
    expect(store.disks).toEqual([refreshedDisk, externalDisk]);
  });

  it('preserves the last good inventory when a live inventory refresh fails', async () => {
    vi.spyOn(DiskService, 'getSystemDisk').mockResolvedValue(currentDisk);
    vi.spyOn(DiskService, 'listDisks').mockRejectedValue(new Error('inventory unavailable'));
    vi.spyOn(LoggerService, 'warn').mockImplementation(() => undefined);
    const store = useAppStore();
    store.disk = currentDisk;
    store.disks = [currentDisk];

    await expect(store.refreshDisks()).resolves.toBe(false);

    expect(store.disk).toEqual(currentDisk);
    expect(store.disks).toEqual([currentDisk]);
  });

});
