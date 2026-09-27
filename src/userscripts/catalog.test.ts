import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  clearUserscripts,
  deleteUserscript,
  getUserscript,
  listUserscripts,
  resolveUserscript,
  saveUserscript,
  seedDefaults,
  seededNamesItem,
  userscriptsItem,
  validateUserscript,
} from './catalog';
import { BUNDLED_USERSCRIPTS, HYPERAGENT_OBSERVE } from './examples';

const draft = {
  name: '  observe  ',
  matches: ['*://hyperagent.com/*'],
  code: 'return 1;',
};

describe('userscript catalog', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('starts empty', async () => {
    await expect(listUserscripts()).resolves.toEqual([]);
  });

  it('creates with a generated uuid, a trimmed name, and a timestamp', async () => {
    const saved = await saveUserscript(draft, () => 1234);

    expect(saved.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(saved.name).toBe('observe');
    expect(saved.updatedAt).toBe(1234);
    await expect(listUserscripts()).resolves.toEqual([saved]);
    await expect(getUserscript(saved.id)).resolves.toEqual(saved);
  });

  it('replaces in place on a known id and keeps list order', async () => {
    const first = await saveUserscript({ ...draft, name: 'first' });
    const second = await saveUserscript({ ...draft, name: 'second' });
    const edited = await saveUserscript({ ...first, code: 'return 2;' });

    const stored = await listUserscripts();
    expect(stored.map((script) => script.id)).toEqual([first.id, second.id]);
    expect(stored[0]!.code).toBe('return 2;');
    expect(edited.id).toBe(first.id);
  });

  it('refuses a create squatting a bundled id, but allows editing the bundled script in place', async () => {
    const pinned = BUNDLED_USERSCRIPTS[0]!.id;
    await expect(saveUserscript({ ...draft, id: pinned })).rejects.toThrow(/reserved for its bundled script/);

    const [seeded] = await seedDefaults(() => 7);
    const edited = await saveUserscript({ ...seeded!, code: 'return 999; // my edit' });
    expect(edited.id).toBe(pinned);
    expect(edited.code).toBe('return 999; // my edit');
  });

  it('deletes, and reports whether anything was removed', async () => {
    const saved = await saveUserscript(draft);
    await expect(deleteUserscript('nope')).resolves.toBe(false);
    await expect(deleteUserscript(saved.id)).resolves.toBe(true);
    await expect(listUserscripts()).resolves.toEqual([]);
  });

  describe('resolveUserscript', () => {
    it('resolves an id exactly like getUserscript', async () => {
      const saved = await saveUserscript(draft);
      await expect(resolveUserscript(saved.id)).resolves.toEqual(saved);
    });

    it('falls back to an unambiguous name (the live ebay-search-extract loop)', async () => {
      const saved = await saveUserscript({ ...draft, name: 'ebay-search-extract' });
      await expect(resolveUserscript('ebay-search-extract')).resolves.toEqual(saved);
    });

    it('refuses an ambiguous name shared by two scripts', async () => {
      await saveUserscript({ ...draft, name: 'dup' });
      await saveUserscript({ ...draft, name: 'dup' });
      await expect(resolveUserscript('dup')).resolves.toBeUndefined();
    });

    it('resolves nothing for an unknown id or name', async () => {
      await saveUserscript(draft);
      await expect(resolveUserscript('nope')).resolves.toBeUndefined();
    });
  });

  describe('validation', () => {
    it('rejects an empty name', () => {
      const result = validateUserscript({ ...draft, name: '   ' });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.errors).toContain('name must not be empty');
    });

    it('rejects empty code', () => {
      const result = validateUserscript({ ...draft, code: '\n \n' });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.errors).toContain('code must not be empty');
    });

    it('rejects an empty allow-list', () => {
      const result = validateUserscript({ ...draft, matches: [] });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.errors[0]).toMatch(/at least one match pattern/);
    });

    it('rejects a malformed match pattern', () => {
      const result = validateUserscript({ ...draft, matches: ['*://hyperagent.com'] });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.errors[0]).toMatch(/invalid match pattern/);
    });

    it('refuses to store an invalid script', async () => {
      await expect(saveUserscript({ ...draft, name: '' })).rejects.toThrow(/invalid userscript/);
      await expect(listUserscripts()).resolves.toEqual([]);
    });
  });

  describe('seedDefaults', () => {
    it('installs every bundled example into an empty catalog', async () => {
      const seeded = await seedDefaults(() => 99);

      // Derived from the bundle rather than hard-coded, so adding a bundled script
      // is not an unrelated test failure.
      expect(seeded.map((s) => s.name)).toEqual(BUNDLED_USERSCRIPTS.map((s) => s.name));
      expect(seeded[0]!).toMatchObject({
        name: 'hyperagent-observe',
        matches: ['*://hyperagent.com/*', '*://www.hyperagent.com/*'],
        updatedAt: 99,
      });
      expect(seeded[0]!.code).toBe(HYPERAGENT_OBSERVE.code);
      expect(seeded[0]!.id).not.toBe('');
      expect(seeded[1]!.name).toBe('ebay-search-extract');
      await expect(listUserscripts()).resolves.toEqual(seeded);
    });

    it('keeps the user\'s own scripts and adds the bundled ones alongside them', async () => {
      const mine = await saveUserscript(draft);

      const after = await seedDefaults();
      expect(after[0]).toEqual(mine);
      expect(after.map((s) => s.name)).toContain('ebay-search-extract');
    });

    it('delivers a newly bundled example to a profile that already has the older one', async () => {
      // The real failure this fixes: a profile seeded before ebay-search-extract
      // existed never received it, because seeding used to require an empty catalog.
      await saveUserscript({ name: 'hyperagent-observe', matches: ['*://hyperagent.com/*'], code: '1' });

      const after = await seedDefaults();
      expect(after.map((s) => s.name).sort()).toEqual(BUNDLED_USERSCRIPTS.map((s) => s.name).sort());
    });

    it('does not resurrect a bundled example the user deleted', async () => {
      const seeded = await seedDefaults();
      const ebay = seeded.find((s) => s.name === 'ebay-search-extract');
      await deleteUserscript(ebay!.id);

      const after = await seedDefaults();
      expect(after.map((s) => s.name)).not.toContain('ebay-search-extract');
    });

    it('offers ebay-ram-comps once to a profile that already has the older seeds', async () => {
      const older = BUNDLED_USERSCRIPTS.filter((seed) => seed.name !== 'ebay-ram-comps');
      await userscriptsItem.setValue(
        older.map((seed) => ({
          id: seed.id,
          name: seed.name,
          matches: [...seed.matches],
          code: seed.code,
          updatedAt: 1,
        })),
      );
      await seededNamesItem.setValue(older.map((seed) => seed.name));

      const offered = await seedDefaults();
      const ram = offered.filter((script) => script.name === 'ebay-ram-comps');
      expect(ram).toHaveLength(1);

      await deleteUserscript(ram[0]!.id);
      const again = await seedDefaults();
      expect(again.map((script) => script.name)).not.toContain('ebay-ram-comps');
    });

    it('is idempotent across repeated calls', async () => {
      const first = await seedDefaults();
      const second = await seedDefaults();

      expect(second).toEqual(first);
      await expect(listUserscripts()).resolves.toHaveLength(BUNDLED_USERSCRIPTS.length);
    });

    it('seeds a script the runner will accept for hyperagent.com', async () => {
      const [example] = await seedDefaults();
      const check = validateUserscript(example!);
      expect(check.ok).toBe(true);
    });

    it('pins stable ids: two fresh profiles seed byte-identical bundled ids', async () => {
      const first = await seedDefaults(() => 99);
      expect(first.map((s) => s.id)).toEqual(BUNDLED_USERSCRIPTS.map((s) => s.id));

      // A second profile: empty storage, same bundle, same ids — this is what lets a
      // cassette recorded in one profile replay in another.
      fakeBrowser.reset();
      const second = await seedDefaults(() => 100);
      expect(second.map((s) => s.id)).toEqual(first.map((s) => s.id));
    });

    it('migrates an unedited pre-stable-id install to the pinned id', async () => {
      const seed = BUNDLED_USERSCRIPTS[1]!;
      await saveUserscript({
        id: 'old-random-uuid',
        name: seed.name,
        matches: [...seed.matches],
        code: seed.code,
      });
      await seededNamesItem.setValue([seed.name]);

      const after = await seedDefaults();
      const migrated = after.find((s) => s.name === seed.name);
      expect(migrated!.id).toBe(seed.id);
      expect(migrated!.code).toBe(seed.code);
      await expect(listUserscripts()).resolves.toEqual(after);
    });

    it('leaves an edited bundled copy on its own id', async () => {
      const seed = BUNDLED_USERSCRIPTS[0]!;
      const mine = await saveUserscript({
        name: seed.name,
        matches: [...seed.matches],
        code: 'return 999; // my edit',
      });
      await seededNamesItem.setValue([seed.name]);

      const after = await seedDefaults();
      const kept = after.find((s) => s.name === seed.name);
      expect(kept!.id).toBe(mine.id);
      expect(kept!.code).toBe('return 999; // my edit');
    });
  });

  it('clears back to the fallback', async () => {
    await saveUserscript(draft);
    await clearUserscripts();
    await expect(userscriptsItem.getValue()).resolves.toEqual([]);
  });
});
