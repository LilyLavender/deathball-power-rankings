// One-off generator for data/map-shapes.json — pre-projected SVG outlines
// for US states + Canadian provinces, used by the Map tab in
// players/aggregate_players.js. State/province borders essentially never
// change, so this isn't run as part of the normal pipeline; regenerate only
// if the map projection/frame needs adjusting.
//
// Needs d3-geo and topojson-client, which aren't project dependencies (the
// rest of the codebase deliberately has none) — install them locally just
// to run this, then they can be removed again:
//   npm install d3-geo topojson-client
//   node data/generate_map_shapes.js
//   npm uninstall d3-geo topojson-client
//
// Usage: node data/generate_map_shapes.js
// Writes: data/map-shapes.json

const fs = require('fs');
const path = require('path');
const https = require('https');
const { geoMercator, geoPath } = require('d3-geo');
const { feature } = require('topojson-client');

const FIPS_TO_USPS = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT',
  '10': 'DE', '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL',
  '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME', '24': 'MD',
  '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE',
  '32': 'NV', '33': 'NH', '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND',
  '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD',
  '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV',
  '55': 'WI', '56': 'WY', '72': 'PR',
};

const PROVINCE_NAME_TO_ABBR = {
  Alberta: 'AB', 'British Columbia': 'BC', Manitoba: 'MB', 'New Brunswick': 'NB',
  'Newfoundland and Labrador': 'NL', 'Nova Scotia': 'NS', 'Northwest Territories': 'NT',
  Nunavut: 'NU', Ontario: 'ON', 'Prince Edward Island': 'PE', Quebec: 'QC',
  Saskatchewan: 'SK', 'Yukon Territory': 'YT', Yukon: 'YT',
};

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function main() {
  const usTopo = await fetchJson('https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json');
  const usGeo = feature(usTopo, usTopo.objects.states);
  const caGeo = await fetchJson('https://cdn.jsdelivr.net/gh/codeforgermany/click_that_hood@master/public/data/canada.geojson');

  // Alaska's westernmost Aleutian islands cross the antimeridian (180th
  // meridian) and are stored with positive longitudes (e.g. 172, really
  // "-188" unwrapped). d3's Mercator normalizes longitude via modulo
  // internally (rotate wraps every lambda into (-180, 180]), so there's no
  // coordinate preprocessing that makes them project contiguously with the
  // rest of the state — "-187" and "173" collapse to the same projected
  // point. Left in, those dozen small island polygons project to a wildly
  // different part of the plane, giving Alaska a raw path bbox thousands of
  // units wide that wrecks any bounding-box math done on it downstream
  // (e.g. a client-side "zoom to fit visible content" calculation). Drop
  // just those tail-island polygons (a small fraction of Alaska's total,
  // all unpopulated) and keep the mainland + rest of the Aleutian chain.
  function dropAntimeridianIslands(geometry) {
    geometry.coordinates = geometry.coordinates.filter(
      (polygon) => !polygon.some((ring) => ring.some((pt) => pt[0] > 0))
    );
  }

  const features = [];
  for (const f of usGeo.features) {
    const abbr = FIPS_TO_USPS[f.id];
    if (!abbr || abbr === 'PR') continue; // Puerto Rico excluded (not contiguous with map area, no player data anyway)
    if (abbr === 'AK') dropAntimeridianIslands(f.geometry);
    features.push({ ...f, properties: { id: abbr, country: 'US' } });
  }
  for (const f of caGeo.features) {
    const abbr = PROVINCE_NAME_TO_ABBR[f.properties.name];
    if (!abbr) continue;
    features.push({ ...f, properties: { id: abbr, country: 'CA' } });
  }

  const fc = { type: 'FeatureCollection', features };

  const WIDTH = 960;
  const HEIGHT = 620;
  // All current player/tournament data sits in the contiguous US + southern
  // Canada, so frame the projection to that box instead of the full dataset
  // (which spans Arctic Nunavut and the Aleutians) — otherwise those far
  // corners dominate fitSize's bounds and shrink the populated area to a
  // sliver in the corner of the canvas. Alaska/Hawaii/far-north territories
  // still get real shapes if the data ever needs them; they just render
  // outside this frame.
  // A Polygon frame gets adaptively resampled along geodesics between its
  // corners, which bulge toward the pole for a long east-west edge and blow
  // up the computed bbox — use MultiPoint corners instead so fitExtent sees
  // exactly these four projected points with no resampling.
  const frame = {
    type: 'Feature',
    geometry: {
      type: 'MultiPoint',
      coordinates: [[-128, 23], [-52, 23], [-52, 56], [-128, 56]],
    },
  };
  const projection = geoMercator().fitExtent([[15, 35], [WIDTH - 15, HEIGHT - 15]], frame);
  const pathGen = geoPath(projection);

  const shapes = features.map((f) => {
    const d = pathGen(f);
    const [cx, cy] = pathGen.centroid(f);
    return { id: f.properties.id, country: f.properties.country, d, cx, cy };
  }).filter((s) => s.d);

  const out = { width: WIDTH, height: HEIGHT, shapes };
  fs.writeFileSync(path.join(__dirname, 'map-shapes.json'), JSON.stringify(out));
  console.log('Wrote', shapes.length, 'shapes');
}

main().catch((err) => { console.error(err); process.exit(1); });
