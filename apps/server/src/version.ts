import pkg from '../package.json' with { type: 'json' };

/** Version of the server package (inlined by the bundler). */
export const PACKAGE_VERSION: string = pkg.version;
