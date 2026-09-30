const MAX_CANDIDATES = 30;

const rejectionText = (r) => (typeof r === "string" ? r : r?.message ?? r?.reason ?? String(r));

/**
 * Releases the model may choose from. Blocklisted, dead and undownloadable
 * releases are removed here in code, never left to the prompt.
 */
export function compactReleases(releases) {
  const kept = releases
    .filter((r) => r.protocol === "torrent")
    .filter((r) => r.downloadAllowed !== false)
    .filter((r) => (r.seeders ?? 0) >= 1)
    .filter((r) => !(r.rejections ?? []).some((x) => /blocklist/i.test(rejectionText(x))))
    .sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0))
    .slice(0, MAX_CANDIDATES);

  return kept.map((r, n) => ({
    release: r,
    view: {
      n,
      title: r.title,
      indexer: r.indexer,
      size_gb: Math.round((r.size / 2 ** 30) * 100) / 100,
      seeders: r.seeders,
      leechers: r.leechers,
      age_days: Math.round((r.ageHours ?? (r.age ?? 0) * 24) / 24),
      quality: r.quality?.quality?.name ?? null,
      parsed_languages: (r.languages ?? []).map((l) => l.name),
      ...(r.fullSeason !== undefined && {
        full_season: r.fullSeason,
        season: r.mappedSeasonNumber ?? r.seasonNumber,
        episodes: r.mappedEpisodeNumbers ?? r.episodeNumbers ?? [],
      }),
      approved: r.approved,
      rejections: (r.rejections ?? []).slice(0, 3).map(rejectionText),
    },
  }));
}

/** The chosen release, or a string saying why the pick is not usable. */
export function resolvePick(target, candidates, pick) {
  if (pick === null) return "no acceptable release";
  const chosen = candidates.find((c) => c.view.n === pick);
  if (!chosen) return `pick ${pick} is not a candidate`;
  const { release } = chosen;
  if (target.kind === "season") {
    const season = release.mappedSeasonNumber ?? release.seasonNumber;
    if (!release.fullSeason || (season !== undefined && season !== target.season)) {
      return `pick ${pick} is not a season ${target.season} pack`;
    }
  }
  return release;
}

export const PICK_SCHEMA = {
  type: "object",
  properties: { pick: { type: ["integer", "null"], minimum: 0 } },
  required: ["pick"],
  additionalProperties: false,
};
