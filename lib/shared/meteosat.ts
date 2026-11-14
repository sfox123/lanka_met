import type { Channel } from './types';

// Meteosat-9 (IODC, 45.5°E) imagery from EUMETSAT View: the whole Indian Ocean disc, every 15 minutes, as WMS tiles.
// It complements the INSAT-3DS sector IMD publishes, which stops at the edges of the Indian region. These are pictures
// only: no cloud index, motion or nowcast is computed from them.
export const MSG_WMS = 'https://view.eumetsat.int/geoserver/wms';
export const MSG_PREFIX = 'msg_iodc';

export type MsgProduct = 'ir108' | 'rgb_convection' | 'rgb_airmass' | 'h63' | 'rgb_naturalenhncd' | 'vis006' | 'wv062' | 'rgb_dust';
export interface MsgProductInfo {
  id: MsgProduct;
  label: string;
  /** one line for the legend box */
  hint: string;
  /** solar channels: black at night */
  day?: boolean;
}

/** products offered for each LankaMet channel button */
export const MSG_PRODUCTS: Record<Channel, MsgProductInfo[]> = {
  ir1: [
    { id: 'ir108', label: 'Infrared', hint: 'IR 10.8 µm: white = cold, high cloud tops; dark = warm surface' },
    { id: 'rgb_convection', label: 'Convection', hint: 'Convection RGB: yellow = severe storms with small ice particles; red/brown = thick ice cloud' },
    { id: 'h63', label: 'Rain rate', hint: 'H SAF rain rate (mm/h): infrared calibrated with microwave sensors; blue light, red heavy' },
    { id: 'rgb_airmass', label: 'Air mass', hint: 'Airmass RGB: green = warm moist tropical air; red/orange = dry upper air; white = high cloud' },
  ],
  vis: [
    { id: 'rgb_naturalenhncd', label: 'Natural colour', hint: 'Natural colour (daytime): cyan = ice cloud, white = water cloud, green = land', day: true },
    { id: 'vis006', label: 'Visible', hint: 'VIS 0.6 µm (daytime): bright = thick cloud', day: true },
    { id: 'rgb_dust', label: 'Dust', hint: 'Dust RGB: magenta = dust; dark red = thick high cloud; works day and night' },
  ],
  wv: [{ id: 'wv062', label: 'Water vapour', hint: 'WV 6.2 µm: dark = dry upper air, white = moist upper air or high cloud' }],
};

/** the view that shows the island in the middle of the disc: Arabia and East Africa to the Malay peninsula */
export const MSG_VIEW: [[number, number], [number, number]] = [
  [40, -22],
  [108, 30],
];

export const MSG_STEP_MS = 15 * 60000;

/** the 15-minute image slot for a timeline instant, never after the latest image EUMETSAT has published */
export function msgSlot(t: number, latest: string | null): string {
  const cap = latest ? Date.parse(latest) : Date.now() - 75 * 60000;
  const slot = Math.floor(Math.min(t, cap) / MSG_STEP_MS) * MSG_STEP_MS;
  return new Date(slot).toISOString().replace('.000Z', 'Z');
}

/** a MapLibre raster tile template for one product at one image time */
export function msgTiles(product: MsgProduct, time: string): string[] {
  const q = new URLSearchParams({
    service: 'WMS',
    version: '1.3.0',
    request: 'GetMap',
    layers: `${MSG_PREFIX}:${product}`,
    styles: '',
    format: 'image/png',
    transparent: 'true',
    crs: 'EPSG:3857',
    width: '256',
    height: '256',
    time,
  });
  // the bbox token is filled in by MapLibre per tile
  return [`${MSG_WMS}?${q.toString()}&bbox={bbox-epsg-3857}`];
}
