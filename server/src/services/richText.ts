import sanitizeHtml from 'sanitize-html';

/**
 * Sanitizes admin-authored rich text (provider bio, service description)
 * before it's persisted. This content is rendered on the public booking page
 * via dangerouslySetInnerHTML, so allowing anything beyond basic formatting
 * (no attributes, no links, no scripts/styles) would let a compromised admin
 * token inject stored XSS against every visitor.
 */
export function sanitizeRichText(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ['b', 'strong', 'i', 'em', 'u', 'p', 'div', 'br', 'ul', 'ol', 'li'],
    allowedAttributes: {},
    disallowedTagsMode: 'discard',
  });
}
