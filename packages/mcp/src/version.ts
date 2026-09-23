// DESIGN-049 D-02 — `serverInfo.version` is the app version: the root package.json release-please bumps
// (`APP_VERSION` overrides it where the image sets one).
import rootPackage from '../../../package.json';

export const APP_VERSION: string = process.env.APP_VERSION?.trim() || rootPackage.version;
