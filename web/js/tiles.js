// Layer latar dari tile raster OSM. Opsional: kalau tile gagal dimuat,
// layer vektor tetap digambar dan UI hanya diberi tahu statusnya.

export class TileLayer {
  constructor({ urlTemplate, tileSize, minZoom, maxZoom, maxCachedTiles, onTileLoad, onStatusChange }) {
    this.urlTemplate = urlTemplate;
    this.tileSize = tileSize;
    this.minZoom = minZoom;
    this.maxZoom = maxZoom;
    this.maxCachedTiles = maxCachedTiles;
    this.onTileLoad = onTileLoad ?? (() => {});
    this.onStatusChange = onStatusChange ?? (() => {});
    this.cache = new Map();
    this.loaded = 0;
    this.failed = 0;
    this.status = 'idle';
    this.frame = 0;
  }

  url(z, x, y) {
    return this.urlTemplate.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  }

  /** Coba lagi tile yang gagal (dipanggil saat basemap dinyalakan ulang). */
  resetErrors() {
    for (const [key, t] of this.cache) if (t.state === 'error') this.cache.delete(key);
    this.failed = 0;
    this.updateStatus();
  }

  updateStatus() {
    let next = 'ok';
    if (this.failed > 0 && this.loaded === 0) next = 'failed';
    else if (this.failed > 0) next = 'partial';
    else if (this.loaded === 0) next = 'loading';
    if (next !== this.status) {
      this.status = next;
      this.onStatusChange(next);
    }
  }

  request(z, x, y) {
    const key = `${z}/${x}/${y}`;
    let tile = this.cache.get(key);
    if (tile) {
      tile.used = this.frame;
      return tile;
    }
    const img = new Image();
    img.decoding = 'async';
    tile = { img, state: 'loading', used: this.frame };
    img.onload = () => {
      tile.state = 'loaded';
      this.loaded++;
      this.updateStatus();
      this.onTileLoad();
    };
    img.onerror = () => {
      tile.state = 'error';
      this.failed++;
      this.updateStatus();
    };
    img.src = this.url(z, x, y);
    this.cache.set(key, tile);
    return tile;
  }

  peek(z, x, y) {
    const t = this.cache.get(`${z}/${x}/${y}`);
    return t && t.state === 'loaded' ? t : null;
  }

  prune() {
    if (this.cache.size <= this.maxCachedTiles) return;
    const entries = [...this.cache.entries()]
      .filter(([, t]) => t.state !== 'loading')
      .sort((a, b) => a[1].used - b[1].used);
    for (const [key] of entries.slice(0, this.cache.size - this.maxCachedTiles)) this.cache.delete(key);
  }

  draw(ctx, viewport) {
    this.frame++;
    const z = Math.max(this.minZoom, Math.min(this.maxZoom, Math.round(viewport.zoom)));
    const n = 2 ** z;
    const size = viewport.scale / n; // ukuran tile di layar (px CSS)
    const [minX, minY, maxX, maxY] = viewport.visibleWorldBounds();
    const x0 = Math.floor(minX * n);
    const x1 = Math.floor(maxX * n);
    const y0 = Math.max(0, Math.floor(minY * n));
    const y1 = Math.min(n - 1, Math.floor(maxY * n));

    ctx.save();
    ctx.imageSmoothingEnabled = true;
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const wx = ((tx % n) + n) % n;
        const [sx, sy] = viewport.worldToScreen(tx / n, ty / n);
        const dx = Math.floor(sx);
        const dy = Math.floor(sy);
        const ds = Math.ceil(size + (sx - dx)) + 1; // +1 px menutup celah antar-tile
        const tile = this.request(z, wx, ty);
        if (tile.state === 'loaded') {
          ctx.drawImage(tile.img, dx, dy, ds, ds);
        } else {
          this.drawParentFallback(ctx, z, wx, ty, dx, dy, ds);
        }
      }
    }
    ctx.restore();
    this.prune();
  }

  /** Selama tile belum siap, pakai potongan tile induk yang sudah ada di cache. */
  drawParentFallback(ctx, z, x, y, dx, dy, ds) {
    for (let dz = 1; dz <= 4 && z - dz >= this.minZoom; dz++) {
      const parent = this.peek(z - dz, x >> dz, y >> dz);
      if (!parent) continue;
      const sub = this.tileSize / 2 ** dz;
      const sx = (x - ((x >> dz) << dz)) * sub;
      const sy = (y - ((y >> dz) << dz)) * sub;
      ctx.drawImage(parent.img, sx, sy, sub, sub, dx, dy, ds, ds);
      return;
    }
  }
}
