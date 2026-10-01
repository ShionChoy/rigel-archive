// The public site's name, address and contacts, in one place: the name and the domain are still to be
// decided with the team (设计文档「十、仍待确认的问题」), so everything that shows them reads them from here.

export const SITE = {
  /** The site's name (a placeholder until the team decides). */
  name: 'Rigël Archive',
  /** Shown beside the name everywhere: the site is not the circle's own. */
  tagline: 'Unofficial Fan Archive',
  /** The circle's official site, linked from the footer and the about page. */
  official: 'https://rigeltheatre.com/',
  /** Where to ask for something to be taken down, or to reach the organizers; null = not decided yet. */
  contact: null as string | null,
  /**
   * Keep search engines out until the name and the domain are settled (the preview on workers.dev is behind
   * Cloudflare Access anyway).
   */
  noindex: true,
};
