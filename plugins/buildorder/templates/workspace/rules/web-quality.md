---
paths:
  - "{{repo}}/src/**/*.{ts,tsx,html,css,scss}"
  - "{{repo}}/index.html"
---

# Web quality from the first commit

Build these in while writing the code; fixing them before go-live costs more.

## Semantics and SEO

- Use landmarks (`<header>`, `<nav>`, `<main>`, `<footer>`) and `<section>` for real sections.
- One `<h1>` per page and no skipped heading levels.
- Every page has its own `<title>`, meta description, canonical link and `og:*` tags.
- For a single-page app, plan pre-rendering or server-side rendering early.

## Accessibility (WCAG AA)

- Every control works with the keyboard alone, with a visible focus; offer a skip link.
- Icon buttons carry an `aria-label`, disclosure widgets `aria-expanded`, purely decorative elements `aria-hidden`.
- Modals trap focus, return it on close and close on Escape.
- Form fields have a `<label for>`; errors are announced (`role="alert"`).
- Respect `prefers-reduced-motion`; text and controls meet AA contrast.

## Performance (LCP, CLS, INP)

- Images in WebP or AVIF with `width` and `height`; `loading="lazy"` below the fold; `fetchpriority="high"` on the LCP image (keeps LCP fast and CLS at zero).
- Self-host fonts as WOFF2 with `font-display: swap`, only the weights in use.
- Keep event handlers short and defer heavy work so interactions stay responsive (INP).
- Do not add a library for a few lines of your own code.

## Responsive

- Define breakpoints once; the mobile layout is a full equal, not a fallback.
- Touch targets are at least 44 x 44 px; every hover effect has a touch or focus equivalent.
- Colors, spacing, radii and shadows are design tokens (custom properties), not one-off values in components.
