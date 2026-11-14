'use client';

import { useEffect } from 'react';
import { CFG } from '@/lib/shared/risk';

export default function CaveatsModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="about-title" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 id="about-title">About &amp; caveats</h2>
          <button className="btn" onClick={onClose} autoFocus>
            Close
          </button>
        </div>
        <p className="must">
          Cloud metrics are derived from IMD&apos;s display imagery, not calibrated satellite data. Nowcasts extrapolate cloud motion and are unreliable beyond about 2 hours. Rain risk combines this with Open-Meteo model forecasts. Use for situational awareness only; refer to the Department of Meteorology, Sri Lanka for official forecasts and warnings.
        </p>
        <h3>What you are looking at</h3>
        <ul>
          <li>
            <b>Observed</b> — INSAT-3DS images published by IMD every 30 minutes, about 45 minutes after each scan. Coastlines, borders and grid lines drawn on the pictures are removed, and the picture is placed on the map.
          </li>
          <li>
            <b>Cloud index</b> — infrared brightness from 0 to 1. Brighter means a colder, higher cloud top. IMD re-stretches the grey scale in every image, so the index is relative: it is not a temperature and not a rainfall amount.
          </li>
          <li>
            <b>Smooth motion</b> — between two frames, clouds are moved along the motion measured between those frames. The in-between pictures are interpolated, not observed. Switch to Slideshow to see only the real frames.
          </li>
          <li>
            <b>Nowcast</b> — the latest frame pushed forward along the latest cloud motion for up to 3 hours. It cannot show storms that grow or die, which is how most tropical rain behaves.
          </li>
          <li>
            <b>Model</b> — Open-Meteo hourly forecasts on a 0.25° grid and at each estate.
          </li>
        </ul>
        <h3>Rain risk</h3>
        <ul>
          <li>
            Per estate, cloud is measured over the estate plus a 12 km buffer (one satellite pixel is about 4 km). Cloud counts from index {CFG.cloudT}, cold tops from {CFG.coldT}, deep convection from {CFG.deepT}.
          </li>
          <li>
            Satellite likelihood = 1 − e<sup>−{CFG.satK} × convective intensity</sup>. Model signal = Open-Meteo chance of rain, counted in full when 3 mm/h or more is forecast and at 70% for a trace.
          </li>
          <li>
            The two are blended: the satellite share is {CFG.wSat[1][1] * 100}% at +30 min, {CFG.wSat[2][1] * 100}% at +1 h, {CFG.wSat[3][1] * 100}% at +3 h and zero after that. Levels: Low below {CFG.levels[0] * 100}%, Moderate to {CFG.levels[1] * 100}%, High to {CFG.levels[2] * 100}%, Very high above.
          </li>
          <li>These weights are starting values. They have not been tuned or validated against rain gauges yet.</li>
        </ul>
        <h3>Weather systems</h3>
        <ul>
          <li>
            Cold-cloud clusters larger than 8,000 km² are scored from 0 to 100 on size, roundness, depth of convection and cyclonic turning, scaled down near the equator. A high score means &quot;organised, worth watching&quot;. It is not a cyclone detection, track forecast or intensity estimate.
          </li>
        </ul>
        <h3>Sources</h3>
        <ul>
          <li>Satellite imagery: IMD / ISRO INSAT-3DS (mausam.imd.gov.in).</li>
          <li>
            <b>Full disc · Meteosat</b> — Meteosat-9 (IODC, 45.5°E) imagery and RGB products served by{' '}
            <a href="https://view.eumetsat.int/" target="_blank" rel="noreferrer">
              EUMETSAT View
            </a>{' '}
            every 15 minutes, © EUMETSAT. Pictures only: the cloud index, motion, nowcast, systems and estate risks are all computed from the INSAT-3DS fields. The rain-rate product is H SAF&apos;s blended
            geostationary estimate, not a measurement. Solar products are black at night.
          </li>
          <li>
            Weather data by <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo.com</a> (CC BY 4.0), including ERA5 climatology.
          </li>
          <li>Basemap: OpenFreeMap, © OpenMapTiles, data © OpenStreetMap contributors. Sri Lanka outline: Natural Earth.</li>
        </ul>
      </div>
    </div>
  );
}
