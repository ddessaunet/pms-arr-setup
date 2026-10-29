// apps/qbittorrent/excluded.ts — the file types qBittorrent never downloads. Pure data.
//
// They are set to "do not download" when a torrent is added, so they are never
// stored or seeded. No media release needs one. configure.ts sends them as
// qBittorrent's excluded_file_names, and apps/decluttarr/config.yaml has one
// remove_failed_imports pattern per entry, which apps/decluttarr/config.test.ts
// checks against this list (trap 14). Add a type here and there together.
//
// Archives (.7z, .zip, .rar) are not here on purpose: the list is global, so a
// torrent added by hand in the `manual` category would finish without its own
// archives. A fake that is one archive downloads, and Decluttarr clears it on
// Radarr/Sonarr's "unsupported extension" message instead (its config.yaml).

export const EXCLUDED_EXTS = ['exe', 'scr', 'bat', 'cmd', 'com', 'pif', 'lnk', 'msi', 'vbs'] as const;

/** "*.exe" one per line, as qBittorrent's excluded_file_names wants them. */
export const excludedNames = (): string => EXCLUDED_EXTS.map((e) => `*.${e}`).join('\n');
