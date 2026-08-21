# rostr — logo and brand assets

For social, decks and print. **Not the product UI** — the app and site keep their own header,
which is unchanged.

The `o` in `rostr` is a football: a solid pointed body with the laces knocked out as negative
space. Type is **Inter 600 at −0.045em tracking**.

## Files

**Lockups**

| File | Use |
| --- | --- |
| `rostr-lockup-dark.png` | Wordmark for dark backgrounds. Transparent, 1480×736. |
| `rostr-lockup-light.png` | Wordmark for light backgrounds. Transparent, 1480×736. |

**Headers with the descriptor — "Fantasy football"**

| File | Use |
| --- | --- |
| `rostr-descriptor-centred.png` | Wordmark over the descriptor, centred. The default. |
| `rostr-descriptor-flush-left.png` | Left-aligned with a hairline. Reads as a masthead. |
| `rostr-descriptor-light.png` | Centred version on a light card. |
| `x-header-descriptor.png` | X header, 1500×500, right-weighted, ball upright. |
| `x-header-descriptor-tilted.png` | Same, ball at −10°. |
| `x-header-descriptor-tilted-centred.png` | Centred, ball at −10°. |

The descriptor is set in **caps at 0.26–0.3em tracking**, not sentence case. It names a
category rather than saying something, and setting it like a sentence makes it read as a
tagline that fell short. The tracking also pulls two short words out to the wordmark's width,
which is what makes it sit as a base rather than float under the middle.

**Headers with the tagline — "Your rostr is yours"**

| File | Use |
| --- | --- |
| `rostr-header-centred.png` | Wordmark over tagline, centred. |
| `rostr-header-flush-left.png` | Left-aligned with a hairline rule. The most formal. |
| `rostr-header-tagline-leads.png` | Phrase at full size, mark signing it above. For covers. |
| `rostr-header-light.png` | Centred version on a light card. |

**X headers — 1500×500, exact**

| File | Use |
| --- | --- |
| `x-header-centred.png` | Centred, so the mobile crop takes evenly from both sides. |
| `x-header-right.png` | Content right of the avatar, rule running in from the left. **Best on a real profile.** |
| `x-header-tagline.png` | The phrase at full size, raised to clear the avatar. |
| `x-header-descriptor.png` | Right-weighted with "Fantasy football" instead of the tagline. |

**The mark alone**

| File | Use |
| --- | --- |
| `rostr-profile-mark-512.png` | Tilted ball on the dark tile, 1024×1024. Profile picture, app icon. |
| `rostr-ball.png` | Ball alone, transparent. |
| `rostr-ball.svg` | Vector, accent-coloured. **Prefer this wherever a vector works.** |
| `rostr-ball-currentcolor.svg` | Inherits `currentColor`, for inline use. |
| `rostr-ball-tilted.svg` | The −10° version used on the profile tile. |
| `rostr-ball-plain.svg` | No laces — for small sizes. |

## Four things that will break it if you redraw it

**The body is 112×72 — 1.56:1.** At the 1.31:1 I first drew it, it read as a purple oval.
Football proportion is what makes the shape legible without laces.

**The laces are knocked out of a solid body, not sitting inside a ring.** An open counter
with a mark floating in its middle is the anatomy of an eye, and that is exactly what the
outlined version looked like. A football is a solid object with stitching on its surface.

**The laces run 40 of the body's 112 units — 36% of its length.** At the 20% I first drew
them they read as a dense scribble at real size. Five knockouts at stroke 4.5 on 8-unit
centres leave a 3.5-unit gap, which holds down to a body about 50px wide, i.e. a lockup of
roughly 60px. Below that use the plain body; the silhouette still reads.

**Tilt is −10°, rotated about the body's own centre (56, 36).** Steeper and the ball starts
to knock into the r's shoulder and drop below the s; shallower and it reads as a mistake
rather than a choice. The upright version is the safer lockup, the tilted one has more life —
both are exported, pick per placement.

**The ball sits `translateY(0.0985em)` below the flex centre.** A flex row centres the SVG on
the *line box*, which is not where an `o` sits. Expressed in `em` so it holds at every size.
If a rebuilt lockup has the ball floating, this is why.

## Colour

Accent `#9184d9` on dark, dropping to `#6f5fc9` on light — `#9184d9` on white measures under
3:1. Wordmark is `#e9e9ed` on dark and `#161826` on light. Tagline `#a3a6b4` on dark,
`#4a4d5c` on light.

## The gap I cannot close

**The wordmark has no vector version.** The ball's SVG is exact and scales forever, but the
letters are live Inter text — an SVG of them only renders where Inter is installed.
Converting them to outlines needs a vector editor. Until then use the PNGs at size, and the
SVG for the mark alone. Do this before anything goes to print.

`logo-export.html` is the source sheet — every asset here is generated from it, with the
geometry documented in one comment block at the top. Change it there and re-export.
