"use client";

import { useState } from "react";

import { teamInitials, teamLogo } from "@/lib/logos";
import type { League } from "@/lib/types";

/**
 * Team crest, falling back to initials only when the image actually fails.
 *
 * An earlier version rendered the initials permanently behind the image, which looked
 * fine for opaque crests and like a rendering glitch for the many logos with
 * transparency — Texas A&M's mark showed "TA" straight through it. There is no
 * server-side way to know which of ~700 college logos will load, so this needs the
 * client's error event.
 */
export function TeamLogo({
  league,
  teamId,
  name,
  size = 26,
}: {
  league: League;
  teamId: string | null;
  name: string | null;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  const src = teamLogo(league, teamId);
  const showInitials = !src || failed;

  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-slate-200/90 ring-1 ring-inset ring-white/10"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {showInitials ? (
        <span
          className="font-semibold text-slate-600"
          style={{ fontSize: Math.max(8, Math.round(size * 0.36)) }}
        >
          {teamInitials(name)}
        </span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          width={size}
          height={size}
          onError={() => setFailed(true)}
          className="h-full w-full scale-[0.82] object-contain"
        />
      )}
    </span>
  );
}
