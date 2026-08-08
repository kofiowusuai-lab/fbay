export function createRepo (db) {
  const stmt = (sql) => db.prepare(sql)

  const sel = {
    listingByFbId: stmt('SELECT * FROM listings WHERE fb_id = ?'),
    identityByHash: stmt('SELECT * FROM identities WHERE content_hash = ?'),
    freshCompSet: stmt('SELECT * FROM compsets WHERE identity_key = ? AND expires_at > ? ORDER BY fetched_at DESC LIMIT 1'),
    compsFor: stmt('SELECT * FROM comps WHERE compset_id = ?'),
    priceHistory: stmt('SELECT * FROM price_history WHERE fb_id = ? ORDER BY observed_at'),
    canary: stmt('SELECT * FROM canaries WHERE name = ?'),
  }

  const ins = {
    priceHistory: stmt('INSERT INTO price_history (fb_id, price_cents, observed_at) VALUES (?, ?, ?)'),
    listing: stmt(`INSERT INTO listings (fb_id, watch_id, title, description, price_cents, url, city, image_urls, seller_name, listed_at, first_seen_at, last_seen_at, delivery, raw)
      VALUES (@fbId, @watchId, @title, @description, @priceCents, @url, @city, @imageUrls, @sellerName, @listedAt, @seenAt, @seenAt, @delivery, @raw)`),
    identity: stmt(`INSERT OR REPLACE INTO identities (content_hash, identity_key, brand, model, variant, capacity, model_year, category, condition, identity_confidence, query, must_tokens, weight_lb, model_used, created_at)
      VALUES (@contentHash, @identityKey, @brand, @model, @variant, @capacity, @modelYear, @category, @condition, @identityConfidence, @query, @mustTokens, @weightLb, @modelUsed, @createdAt)`),
    compset: stmt(`INSERT INTO compsets (identity_key, marketplace, trimmed_median_cents, p25_cents, p75_cents, sample_n, raw_n, active_count, sold_count, sell_through, sold_per_week, days_of_supply, confidence, fetched_at, expires_at)
      VALUES (@identityKey, @marketplace, @trimmedMedianCents, @p25Cents, @p75Cents, @sampleN, @rawN, @activeCount, @soldCount, @sellThrough, @soldPerWeek, @daysOfSupply, @confidence, @fetchedAt, @expiresAt)`),
    comp: stmt(`INSERT INTO comps (compset_id, ebay_item_id, title, price_cents, shipping_cents, sold_at, condition, url, included, exclude_reason)
      VALUES (@compsetId, @ebayItemId, @title, @priceCents, @shippingCents, @soldAt, @condition, @url, @included, @excludeReason)`),
  }

  const upd = {
    listingSeen: stmt('UPDATE listings SET last_seen_at = ?, price_cents = ?, is_active = 1 WHERE fb_id = ?'),
    listingDetail: stmt('UPDATE listings SET description = ?, image_urls = ?, seller_name = ?, delivery = ? WHERE fb_id = ?'),
  }

  return {
    db,

    tableNames () {
      return db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
    },

    countListings () {
      return db.prepare('SELECT COUNT(*) c FROM listings').get().c
    },

    upsertListing (l) {
      const existing = sel.listingByFbId.get(l.fbId)
      const row = {
        fbId: l.fbId,
        watchId: l.watchId ?? null,
        title: l.title,
        description: l.description ?? null,
        priceCents: l.priceCents,
        url: l.url,
        city: l.city ?? null,
        imageUrls: l.imageUrls ? JSON.stringify(l.imageUrls) : null,
        sellerName: l.sellerName ?? null,
        listedAt: l.listedAt ?? null,
        seenAt: l.seenAt,
        delivery: l.delivery ?? null,
        raw: l.raw ? JSON.stringify(l.raw) : null,
      }
      if (!existing) {
        const info = ins.listing.run(row)
        ins.priceHistory.run(l.fbId, l.priceCents, l.seenAt)
        return { isNew: true, id: info.lastInsertRowid, priceChanged: false, previousPriceCents: null }
      }
      const priceChanged = existing.price_cents !== l.priceCents
      upd.listingSeen.run(l.seenAt, l.priceCents, l.fbId)
      if (priceChanged) ins.priceHistory.run(l.fbId, l.priceCents, l.seenAt)
      return { isNew: false, id: existing.id, priceChanged, previousPriceCents: existing.price_cents }
    },

    updateListingDetail (fbId, d) {
      upd.listingDetail.run(
        d.description ?? null,
        d.imageUrls ? JSON.stringify(d.imageUrls) : null,
        d.sellerName ?? null,
        d.delivery ?? null,
        fbId
      )
    },

    getListing (fbId) { return sel.listingByFbId.get(fbId) },
    priceHistory (fbId) { return sel.priceHistory.all(fbId) },

    getIdentityByContentHash (h) { return sel.identityByHash.get(h) },

    saveIdentity (i) {
      ins.identity.run({
        contentHash: i.contentHash,
        identityKey: i.identityKey,
        brand: i.brand ?? null,
        model: i.model ?? null,
        variant: i.variant ?? null,
        capacity: i.capacity ?? null,
        modelYear: i.modelYear ?? null,
        category: i.category,
        condition: i.condition,
        identityConfidence: i.identityConfidence,
        query: i.query,
        mustTokens: JSON.stringify(i.mustTokens ?? []),
        weightLb: i.weightLb ?? null,
        modelUsed: i.modelUsed ?? null,
        createdAt: i.createdAt ?? Date.now(),
      })
    },

    getFreshCompSet (identityKey, now) { return sel.freshCompSet.get(identityKey, now) },

    saveCompSet (cs, comps = []) {
      const tx = db.transaction(() => {
        const info = ins.compset.run({
          identityKey: cs.identityKey,
          marketplace: cs.marketplace,
          trimmedMedianCents: cs.trimmedMedianCents,
          p25Cents: cs.p25Cents ?? null,
          p75Cents: cs.p75Cents ?? null,
          sampleN: cs.sampleN,
          rawN: cs.rawN,
          activeCount: cs.activeCount,
          soldCount: cs.soldCount,
          sellThrough: cs.sellThrough,
          soldPerWeek: cs.soldPerWeek ?? null,
          daysOfSupply: cs.daysOfSupply ?? null,
          confidence: cs.confidence,
          fetchedAt: cs.fetchedAt,
          expiresAt: cs.expiresAt,
        })
        const id = info.lastInsertRowid
        for (const c of comps) {
          ins.comp.run({
            compsetId: id,
            ebayItemId: c.ebayItemId ?? null,
            title: c.title,
            priceCents: c.priceCents,
            shippingCents: c.shippingCents ?? null,
            soldAt: c.soldAt ?? null,
            condition: c.condition ?? null,
            url: c.url ?? null,
            included: c.included ? 1 : 0,
            excludeReason: c.excludeReason ?? null,
          })
        }
        return id
      })
      return { id: tx() }
    },

    compsFor (compsetId) { return sel.compsFor.all(compsetId) },

    upsertDeal (d) {
      const existing = db.prepare('SELECT id FROM deals WHERE listing_id = ?').get(d.listingId)
      const row = {
        listingId: d.listingId,
        identityKey: d.identityKey ?? null,
        compsetId: d.compsetId ?? null,
        grossCents: d.grossCents ?? null,
        netProfitCents: d.netProfitCents ?? null,
        roi: d.roi ?? null,
        margin: d.margin ?? null,
        breakevenBuyCents: d.breakevenBuyCents ?? null,
        score: d.score ?? null,
        confidence: d.confidence ?? null,
        status: d.status ?? 'new',
        rejections: d.rejections ? JSON.stringify(d.rejections) : null,
        error: d.error ?? null,
        now: d.now ?? Date.now(),
      }
      if (existing) {
        db.prepare(`UPDATE deals SET identity_key=@identityKey, compset_id=@compsetId, gross_cents=@grossCents,
          net_profit_cents=@netProfitCents, roi=@roi, margin=@margin, breakeven_buy_cents=@breakevenBuyCents,
          score=@score, confidence=@confidence, status=@status, rejections=@rejections, error=@error, updated_at=@now
          WHERE listing_id=@listingId`).run(row)
        return { id: existing.id, isNew: false }
      }
      const info = db.prepare(`INSERT INTO deals (listing_id, identity_key, compset_id, gross_cents, net_profit_cents, roi, margin, breakeven_buy_cents, score, confidence, status, rejections, error, created_at, updated_at)
        VALUES (@listingId, @identityKey, @compsetId, @grossCents, @netProfitCents, @roi, @margin, @breakevenBuyCents, @score, @confidence, @status, @rejections, @error, @now, @now)`).run(row)
      return { id: info.lastInsertRowid, isNew: true }
    },

    listDeals ({ status, limit = 50 } = {}) {
      const cols = 'd.*, l.title, l.price_cents ask_cents, l.url, l.image_urls, l.city'
      return status
        ? db.prepare(`SELECT ${cols} FROM deals d JOIN listings l ON l.id = d.listing_id WHERE d.status = ? ORDER BY d.score DESC LIMIT ?`).all(status, limit)
        : db.prepare(`SELECT ${cols} FROM deals d JOIN listings l ON l.id = d.listing_id ORDER BY d.score DESC LIMIT ?`).all(limit)
    },

    setDealStatus (id, status, now = Date.now()) {
      db.prepare('UPDATE deals SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id)
    },

    saveMessage (m) {
      const info = db.prepare('INSERT INTO messages (deal_id, body, offer_cents, generated_at, status) VALUES (?, ?, ?, ?, ?)')
        .run(m.dealId, m.body, m.offerCents, m.generatedAt ?? Date.now(), m.status ?? 'draft')
      return { id: info.lastInsertRowid }
    },

    startRun (watchId, now) {
      return db.prepare('INSERT INTO runs (watch_id, started_at) VALUES (?, ?)').run(watchId ?? null, now).lastInsertRowid
    },

    finishRun (id, { now, listingsSeen, listingsNew, dealsFound, errors, status }) {
      db.prepare('UPDATE runs SET finished_at=?, listings_seen=?, listings_new=?, deals_found=?, errors=?, status=? WHERE id=?')
        .run(now, listingsSeen, listingsNew, dealsFound, errors && errors.length ? JSON.stringify(errors) : null, status, id)
    },

    addWatch (w) {
      const info = db.prepare(`INSERT INTO watches (name, query, category, city, radius_km, min_price_cents, max_price_cents, sort, interval_minutes, created_at)
        VALUES (@name, @query, @category, @city, @radiusKm, @minPriceCents, @maxPriceCents, @sort, @intervalMinutes, @createdAt)`).run({
        name: w.name,
        query: w.query,
        category: w.category ?? null,
        city: w.city,
        radiusKm: w.radiusKm ?? 40,
        minPriceCents: w.minPriceCents ?? null,
        maxPriceCents: w.maxPriceCents ?? null,
        sort: w.sort ?? 'creation_time_descend',
        intervalMinutes: w.intervalMinutes ?? 60,
        createdAt: w.createdAt ?? Date.now(),
      })
      return { id: info.lastInsertRowid }
    },

    listWatches ({ enabledOnly = false } = {}) {
      return enabledOnly
        ? db.prepare('SELECT * FROM watches WHERE enabled = 1 ORDER BY name').all()
        : db.prepare('SELECT * FROM watches ORDER BY name').all()
    },

    setWatchEnabled (name, enabled) {
      db.prepare('UPDATE watches SET enabled = ? WHERE name = ?').run(enabled ? 1 : 0, name)
    },

    removeWatch (name) {
      db.prepare('DELETE FROM watches WHERE name = ?').run(name)
    },

    touchWatch (id, now) {
      db.prepare('UPDATE watches SET last_run_at = ? WHERE id = ?').run(now, id)
    },

    recordCanary (name, ok, now, detail = null) {
      const row = sel.canary.get(name)
      if (!row) {
        db.prepare('INSERT INTO canaries (name, last_ok_at, last_fail_at, consecutive_failures, detail) VALUES (?, ?, ?, ?, ?)')
          .run(name, ok ? now : null, ok ? null : now, ok ? 0 : 1, detail)
        return
      }
      db.prepare('UPDATE canaries SET last_ok_at = ?, last_fail_at = ?, consecutive_failures = ?, detail = ? WHERE name = ?')
        .run(ok ? now : row.last_ok_at, ok ? row.last_fail_at : now, ok ? 0 : row.consecutive_failures + 1, detail, name)
    },

    getCanary (name) { return sel.canary.get(name) },

    prune (beforeTs) {
      const tx = db.transaction(() => {
        db.prepare('DELETE FROM comps WHERE compset_id IN (SELECT id FROM compsets WHERE fetched_at < ?)').run(beforeTs)
        db.prepare('DELETE FROM compsets WHERE fetched_at < ?').run(beforeTs)
        db.prepare("DELETE FROM listings WHERE last_seen_at < ? AND id NOT IN (SELECT listing_id FROM deals WHERE status IN ('bought','pursuing'))").run(beforeTs)
      })
      tx()
    },

    stats () {
      return {
        listings: db.prepare('SELECT COUNT(*) c FROM listings').get().c,
        deals: db.prepare('SELECT COUNT(*) c FROM deals').get().c,
        identities: db.prepare('SELECT COUNT(*) c FROM identities').get().c,
        compsets: db.prepare('SELECT COUNT(*) c FROM compsets').get().c,
        watches: db.prepare('SELECT COUNT(*) c FROM watches').get().c,
      }
    },
  }
}
