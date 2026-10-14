// The public site's name and contacts, in one place: everything that shows them reads them from here. The
// site's addresses are in wrangler.jsonc (PUBLIC_HOST, ADMIN_HOST; https://rigeltheatre.fans).

export const SITE = {
  /** The site's name (a placeholder until the team decides). */
  name: 'Rigël Archive',
  /** Shown beside the name everywhere: the site is not the circle's own. */
  tagline: 'Unofficial Fan Archive',
  /** The circle's official site, linked from the footer and the about page. */
  official: 'https://rigeltheatre.com/',
  /**
   * Where to ask for something to be taken down, or to reach the organizers; null = not decided yet. The address
   * is Cloudflare Email Routing on the domain, forwarded to the organizers' own mailbox.
   */
  contact: 'contact@rigeltheatre.fans' as string | null,
  /** Keep search engines out (robots.txt, x-robots-tag and the pages' robots meta). */
  noindex: false,
};
