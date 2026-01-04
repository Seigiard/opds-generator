// Image size constants
export const COVER_MAX_SIZE = 1400;
export const THUMBNAIL_MAX_SIZE = 512;

// File constants for the contract between Bun and nginx
// These names are used in both TypeScript code and nginx.conf.template
export const FEED_FILE = "feed.xml";
export const ENTRY_FILE = "entry.xml";
export const FOLDER_ENTRY_FILE = "_entry.xml";
export const BOOK_FILE = "file";
export const COVER_FILE = "cover.jpg";
export const THUMB_FILE = "thumb.jpg";
