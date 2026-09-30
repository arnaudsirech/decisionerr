const HOUR = 3_600_000;

/**
 * Missing monitored episodes, grouped: a season with 2+ missing episodes is one
 * season search, a lone missing episode is an episode search.
 */
export function sonarrTargets(missing, { now, minAiredHours }) {
  const cutoff = now.getTime() - minAiredHours * HOUR;
  const seasons = new Map();
  for (const episode of missing) {
    if (!episode.monitored || episode.hasFile) continue;
    if (!episode.airDateUtc || Date.parse(episode.airDateUtc) > cutoff) continue;
    const key = `${episode.seriesId}:${episode.seasonNumber}`;
    if (!seasons.has(key)) seasons.set(key, []);
    seasons.get(key).push(episode);
  }
  const targets = [];
  for (const episodes of seasons.values()) {
    const { series, seriesId, seasonNumber } = episodes[0];
    const base = {
      app: "sonarr",
      title: series.title,
      year: series.year,
      originalLanguage: series.originalLanguage?.name ?? null,
      seriesType: series.seriesType,
      seriesId,
      season: seasonNumber,
      missingEpisodes: episodes.map((e) => e.episodeNumber).sort((a, b) => a - b),
    };
    if (episodes.length >= 2) {
      targets.push({ ...base, kind: "season", key: `sonarr:season:${seriesId}:${seasonNumber}` });
    } else {
      targets.push({ ...base, kind: "episode", episodeId: episodes[0].id, key: `sonarr:episode:${episodes[0].id}` });
    }
  }
  return targets;
}

export function radarrTargets(movies) {
  return movies
    .filter((m) => m.monitored && !m.hasFile && m.isAvailable)
    .map((m) => ({
      app: "radarr",
      kind: "movie",
      key: `radarr:movie:${m.id}`,
      movieId: m.id,
      title: m.title,
      year: m.year,
      originalLanguage: m.originalLanguage?.name ?? null,
    }));
}

/** Never-asked targets first, then the longest ago; skips those still cooling down. */
export function dueTargets(targets, asked, { now, cooldownHours, limit }) {
  const cutoff = now.getTime() - cooldownHours * HOUR;
  return targets
    .map((t) => ({ t, last: asked[t.key] ? Date.parse(asked[t.key]) : 0 }))
    .filter(({ last }) => last <= cutoff)
    .sort((a, b) => a.last - b.last)
    .slice(0, limit)
    .map(({ t }) => t);
}

export function searchPath(target) {
  if (target.kind === "season") return `/api/v3/release?seriesId=${target.seriesId}&seasonNumber=${target.season}`;
  if (target.kind === "episode") return `/api/v3/release?episodeId=${target.episodeId}`;
  return `/api/v3/release?movieId=${target.movieId}`;
}
