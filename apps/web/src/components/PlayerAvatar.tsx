"use client";

import { useEffect, useState } from "react";
import { initialsOf, positionColour, positionGroup, sizedImage } from "@/lib/player";

/**
 * A player's face, or his initials.
 *
 * **The fallback is the normal case, not the error case.** Roughly one player in
 * ten has no published photo, a rookie's headshot appears weeks late, and a team
 * defense has a crest rather than a face at all. So a missing image renders as a
 * deliberate initialled disc in the position's own colour rather than a broken
 * image icon or a hole in the row.
 *
 * A plain `<img>`, not `next/image`, and that is a decision rather than an
 * oversight. `next/image` requires every image host to be listed in
 * `next.config.ts` — which would put a stats provider's hostname into the
 * application's build configuration, where nothing else knows one, and would
 * break silently the day the provider changes CDN. The URL is data: the provider
 * publishes it, the adapter maps it, and this renders whatever it is handed.
 */
export function PlayerAvatar({
  name,
  positions,
  imageUrl,
  size = 36,
  className = "",
}: {
  name: string;
  positions: readonly string[];
  imageUrl: string | null;
  /** Rendered pixel size. Also what the image host is asked for. */
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  // A row can be recycled onto a different player as the board filters, and a
  // stale `failed` would blank a face that loads perfectly well. Keyed on the
  // URL rather than the name, because that is what the <img> actually requests.
  useEffect(() => setFailed(false), [imageUrl]);

  const group = positionGroup(positions);
  const source = failed ? null : sizedImage(imageUrl, size);

  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full ring-1 ${positionColour(group)} ${className}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {source ? (
        <img
          src={source}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <span
          className="font-semibold"
          // Scaled rather than a class, since the same component draws a 24px
          // row avatar and a 96px card portrait.
          style={{ fontSize: Math.max(9, Math.round(size * 0.36)) }}
        >
          {initialsOf(name)}
        </span>
      )}
    </span>
  );
}
