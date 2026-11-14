import { PALETTES, type PaletteId } from './palettes';
import type { Channel } from './types';

// Meteosat-9 (IODC, 45.5°E) imagery from EUMETSAT View: the whole Indian Ocean disc, every 15 minutes, as WMS tiles.
// It complements the INSAT-3DS sector IMD publishes, which stops at the edges of the Indian region. These are pictures
// only: no cloud index, motion or nowcast is computed from them.
//
// EUMETSAT serves the single-channel images in grey. For those, the tiles can be coloured in the browser with the same
// look-up tables as the INSAT view (MapView registers a `msgpal://` tile protocol that does the recolouring), so the
// full disc has an Enhanced, Rain-potential and Moisture colouring too. The grey scale on Meteosat is a fixed
// brightness-temperature scale rather than IMD's per-image stretch, so the colour bands are indicative.
export const MSG_WMS = 'https://view.eumetsat.int/geoserver/wms';
export const MSG_PREFIX = 'msg_iodc';
export const MSG_PROTOCOL = 'msgpal';

export type MsgLayer = 'ir108' | 'rgb_convection' | 'rgb_airmass' | 'h63' | 'rgb_naturalenhncd' | 'vis006' | 'wv062' | 'rgb_dust';
export type MsgProduct = 'ir_enh' | 'ir_rain' | 'ir108' | 'rgb_convection' | 'rgb_airmass' | 'h63' | 'rgb_naturalenhncd' | 'vis006' | 'rgb_dust' | 'wv_moist' | 'wv062';
export interface MsgProductInfo {
  id: MsgProduct;
  layer: MsgLayer;
  label: string;
  /** one line for the legend box */
  hint: string;
  /** colour the grey image with this LankaMet palette (single-channel layers only) */
  palette?: PaletteId;
  /** solar channels: black at night */
  day?: boolean;
}

/** products offered for each LankaMet channel button */
export const MSG_PRODUCTS: Record<Channel, MsgProductInfo[]> = {
  ir1: [
    { id: 'ir_enh', layer: 'ir108', label: 'Enhanced', palette: 'enhanced', hint: 'IR 10.8 µm coloured by cloud-top coldness, same ramp as the INSAT view (bands indicative)' },
    { id: 'ir_rain', layer: 'ir108', label: 'Rain potential', palette: 'rain', hint: 'IR 10.8 µm: only cloud cold enough to rain, same ramp as the INSAT view (bands indicative)' },
    { id: 'ir108', layer: 'ir108', label: 'Satellite', hint: 'IR 10.8 µm as served: white = cold, high cloud tops; dark = warm surface' },
    { id: 'rgb_convection', layer: 'rgb_convection', label: 'Convection', hint: 'Convection RGB: yellow = severe storms with small ice particles; red/brown = thick ice cloud' },
    { id: 'h63', layer: 'h63', label: 'Rain rate', hint: 'H SAF rain rate (mm/h): infrared calibrated with microwave sensors; blue light, red heavy' },
    { id: 'rgb_airmass', layer: 'rgb_airmass', label: 'Air mass', hint: 'Airmass RGB: green = warm moist tropical air; red/orange = dry upper air; white = high cloud' },
  ],
  vis: [
    { id: 'rgb_naturalenhncd', layer: 'rgb_naturalenhncd', label: 'Natural colour', hint: 'Natural colour (daytime): cyan = ice cloud, white = water cloud, green = land', day: true },
    { id: 'vis006', layer: 'vis006', label: 'Visible', hint: 'VIS 0.6 µm (daytime): bright = thick cloud', day: true },
    { id: 'rgb_dust', layer: 'rgb_dust', label: 'Dust', hint: 'Dust RGB: magenta = dust; dark red = thick high cloud; works day and night' },
  ],
  wv: [
    { id: 'wv_moist', layer: 'wv062', label: 'Moisture', palette: 'moisture', hint: 'WV 6.2 µm coloured dry (brown) to moist (teal), same ramp as the INSAT view' },
    { id: 'wv062', layer: 'wv062', label: 'Satellite', hint: 'WV 6.2 µm as served: dark = dry upper air, white = moist upper air or high cloud' },
  ],
};
const ALL = Object.values(MSG_PRODUCTS).flat();
export const msgProduct = (id: MsgProduct): MsgProductInfo => ALL.find((p) => p.id === id) ?? ALL[0];

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

/** the WMS GetMap template for one layer at one image time; MapLibre fills in the bbox per tile */
export function msgWmsUrl(layer: MsgLayer, time: string): string {
  const q = new URLSearchParams({
    service: 'WMS',
    version: '1.3.0',
    request: 'GetMap',
    layers: `${MSG_PREFIX}:${layer}`,
    styles: '',
    format: 'image/png',
    transparent: 'true',
    crs: 'EPSG:3857',
    width: '256',
    height: '256',
    time,
  });
  return `${MSG_WMS}?${q.toString()}&bbox={bbox-epsg-3857}`;
}

/** MapLibre raster tiles for a product: plain WMS, or the same through the recolouring protocol */
export function msgTiles(p: MsgProductInfo, time: string): string[] {
  const url = msgWmsUrl(p.layer, time);
  return [p.palette ? `${MSG_PROTOCOL}://${p.palette}/${url}` : url];
}

/** split a `msgpal://<palette>/<url>` tile request */
export function parseMsgPal(url: string): { palette: PaletteId; url: string } | null {
  const m = new RegExp(`^${MSG_PROTOCOL}://([a-z]+)/(.+)$`).exec(url);
  return m && m[1] in PALETTES ? { palette: m[1] as PaletteId, url: m[2] } : null;
}

/** colour a grey RGBA image in place with a LankaMet palette: grey level → LUT colour and alpha */
export function recolour(data: Uint8ClampedArray, palette: PaletteId): void {
  const lut = PALETTES[palette].lut;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue; // outside the disc
    const k = data[i] * 4; // the image is grey: R = G = B
    data[i] = lut[k];
    data[i + 1] = lut[k + 1];
    data[i + 2] = lut[k + 2];
    data[i + 3] = lut[k + 3];
  }
}
