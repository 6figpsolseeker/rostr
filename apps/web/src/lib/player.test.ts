import { describe, expect, it } from "vitest";
import {
  ageOn,
  byeChip,
  clubLabel,
  heightText,
  initialsOf,
  injuryBadge,
  injuryTone,
  points,
  positionColour,
  positionGroup,
  shortName,
  sizedImage,
} from "./player.js";

describe("positionGroup", () => {
  it("files a player under the first position the roster cares about", () => {
    expect(positionGroup(["WR", "RB"])).toBe("RB");
  });

  it("keeps an unmodelled position visible rather than blanking it", () => {
    expect(positionGroup(["LS"])).toBe("LS");
  });

  it("answers a dash for a player with no position at all", () => {
    expect(positionGroup([])).toBe("—");
  });
});

describe("positionColour", () => {
  it("gives every roster position its own pair", () => {
    const seen = new Set(
      ["QB", "RB", "WR", "TE", "K", "DEF"].map((position) => positionColour(position)),
    );
    expect(seen.size).toBe(6);
  });

  it("falls back rather than returning an empty class string", () => {
    // An empty string renders an unstyled chip that looks like a bug. A neutral
    // one reads as "we do not colour this position", which is the truth.
    expect(positionColour("LS")).toContain("nocturne-neutral");
  });
});

describe("initialsOf", () => {
  it("takes the first and last word", () => {
    expect(initialsOf("Jalen Hurts")).toBe("JH");
  });

  it("skips punctuation rather than printing it", () => {
    // "Amon-Ra St. Brown" through a naive split gives "AS", and through a
    // first-two-words rule gives "A." — both wrong on a real player.
    expect(initialsOf("Amon-Ra St. Brown")).toBe("AB");
  });

  it("gives one letter for a one-word name", () => {
    expect(initialsOf("Cowboys")).toBe("C");
  });

  it("answers something for a name of pure punctuation", () => {
    expect(initialsOf("—")).toBe("?");
  });
});

describe("ageOn", () => {
  const born = "1998-08-07";

  it("counts whole years", () => {
    expect(ageOn(born, new Date("2026-08-18T00:00:00Z"))).toBe(28);
  });

  it("does not round up the day before a birthday", () => {
    expect(ageOn(born, new Date("2026-08-06T23:59:00Z"))).toBe(27);
  });

  it("turns over on the birthday itself", () => {
    expect(ageOn(born, new Date("2026-08-07T00:00:00Z"))).toBe(28);
  });

  it("is right across a leap year, where dividing milliseconds is not", () => {
    // 29 February exists in 2028. A player born 1 March 2000 is 28 on
    // 1 March 2028, and a days-divided-by-365.25 age answers 27.
    expect(ageOn("2000-03-01", new Date("2028-03-01T12:00:00Z"))).toBe(28);
  });

  it("answers null for a missing or malformed date", () => {
    expect(ageOn(null, new Date())).toBeNull();
    expect(ageOn("7/29/1993", new Date())).toBeNull();
  });
});

describe("heightText", () => {
  it("renders feet and inches", () => {
    expect(heightText(74)).toBe(`6'2"`);
  });

  it("keeps a whole-foot height honest", () => {
    expect(heightText(72)).toBe(`6'0"`);
  });

  it("answers null rather than zero feet", () => {
    expect(heightText(null)).toBeNull();
    expect(heightText(0)).toBeNull();
  });
});

describe("injuryBadge", () => {
  it("abbreviates the designations the provider actually publishes", () => {
    expect(injuryBadge("Questionable")).toBe("Q");
    expect(injuryBadge("Out")).toBe("OUT");
    expect(injuryBadge("Injured Reserve")).toBe("IR");
  });

  it("truncates an unfamiliar designation rather than dropping it", () => {
    // The failure this prevents: a provider adds a fourth word and every player
    // carrying it renders as healthy on a screen somebody sets a lineup from.
    expect(injuryBadge("Reserve/COVID-19")).toBe("RES");
  });

  it("treats a fit player and an empty string alike", () => {
    expect(injuryBadge(null)).toBeNull();
    expect(injuryBadge("   ")).toBeNull();
  });
});

describe("injuryTone", () => {
  it("separates doubt from absence", () => {
    expect(injuryTone("Questionable")).not.toBe(injuryTone("Out"));
  });

  it("says nothing about a fit player", () => {
    expect(injuryTone(null)).toBe("");
  });
});

describe("sizedImage", () => {
  it("asks a resizing host for the size being drawn", () => {
    const url = "https://example.test/combiner/i?img=/i/headshots/nfl/players/full/1.png";
    expect(sizedImage(url, 40)).toBe(`${url}&w=80&h=80`);
  });

  it("leaves a plain image URL alone", () => {
    const url = "https://example.test/i/headshots/nfl/players/full/1.png";
    expect(sizedImage(url, 40)).toBe(url);
  });

  it("does not override a size the provider already chose", () => {
    const url = "https://example.test/combiner/i?img=/x.png&w=200&h=146";
    expect(sizedImage(url, 40)).toBe(url);
  });

  it("passes a missing image through", () => {
    expect(sizedImage(null, 40)).toBeNull();
  });
});

describe("points", () => {
  it("renders milli-points to one decimal", () => {
    expect(points(213_400)).toBe("213.4");
  });

  it("distinguishes an unprojected player from a projected zero", () => {
    // Showing a confident 0.0 for a player nobody has published a projection
    // for is a worse answer than showing nothing.
    expect(points(null)).toBe("—");
    expect(points(0)).toBe("0.0");
  });
});

describe("shortName", () => {
  it("initials the given name and keeps the surname", () => {
    expect(shortName("Christian McCaffrey")).toBe("C. McCaffrey");
  });

  it("keeps every part of a compound surname", () => {
    // Truncating instead would give "Amon-Ra St…", which is not a name.
    expect(shortName("Amon-Ra St. Brown")).toBe("A. St. Brown");
  });

  it("leaves a one-word name alone", () => {
    expect(shortName("Cowboys")).toBe("Cowboys");
  });
});

describe("what a released player's card says — #308", () => {
  /*
    PR #304 made a player his NFL club released acquirable on purpose, and
    labelled him where he is *chosen*. The card is where the choosing actually
    happens — it opens from the draft board and from the market, one click after
    a correct "No NFL club" label — and it contradicted that label in three
    places at once: a blank where the club goes, a stale bye week, and the words
    "Free agent" in the fantasy sense.
  */

  it("names the fact instead of rendering a blank", () => {
    // Was `{player?.teamRef && <span>…</span>}` with no else, so a released
    // player got nothing at all and nothing took its place.
    expect(clubLabel({ teamRef: null, onNflRoster: false })).toBe("Not on an NFL roster");
  });

  it("still says FA for a listed player whose club we do not hold", () => {
    /*
      **The half a `teamRef` check gets wrong.** The adapter reads `team` and
      `isFreeAgent` separately, so a listed player can arrive with a blank club.
      "FA" means *fantasy* free agent and is right for him; the longer sentence
      would be a claim about his employment that we have no basis for.
    */
    expect(clubLabel({ teamRef: null, onNflRoster: true })).toBe("FA");
  });

  it("names the fact even when the provider still prints a club", () => {
    /*
      **The other half, and the one nothing in this repo caught before.** A
      released player can keep a club abbreviation — `active` and `team_ref` come
      from different provider fields. Keyed on `teamRef` this row reads "PHI" and
      says nothing is wrong.
    */
    expect(clubLabel({ teamRef: "PHI", onNflRoster: false })).toBe("Not on an NFL roster");
  });

  it("drops a bye that belongs to the club that cut him", () => {
    /*
      `syncByeWeeks` inserts `WHERE team_ref = $3`, so it never revisits a
      released player to clear the row his old club gave him. The card printed
      `bye 9` from it — specific, plausible, false, every time it was opened.
    */
    expect(byeChip({ byeWeek: 9, onNflRoster: false })).toBeNull();
  });

  it("keeps the bye for everyone else", () => {
    // The control. A bye is a real and useful fact about a listed player, and a
    // blanket suppression would take it from the screen that exists to inform a
    // draft pick.
    expect(byeChip({ byeWeek: 9, onNflRoster: true })).toBe(9);
    expect(byeChip({ byeWeek: null, onNflRoster: true })).toBeNull();
  });
});
