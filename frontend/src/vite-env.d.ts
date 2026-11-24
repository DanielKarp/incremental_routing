/// <reference types="vite/client" />

// The build's settings for walk and bike routing (DEPLOY.md; read in api.ts). Blank is unset.
interface ImportMetaEnv {
  /** "valhalla" (the default) or "straight-line". */
  readonly VITE_ROUTING_PROVIDER?: string;
  /** A Valhalla /route endpoint that takes requests from other sites; FOSSGIS's by default. */
  readonly VITE_VALHALLA_ROUTE_URL?: string;
}
