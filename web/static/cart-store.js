const HackuCart = (() => {
  const KEY = "hacku.cart";

  function load() {
    try {
      const items = JSON.parse(localStorage.getItem(KEY) || "[]");
      return Array.isArray(items) ? items : [];
    } catch {
      return [];
    }
  }

  function save(items) {
    localStorage.setItem(KEY, JSON.stringify(items));
  }

  function idOf(product) {
    return product.url || `${product.name}|${product.store}|${product.price}`;
  }

  function add(product) {
    const items = load();
    const id = idOf(product);
    const found = items.find((item) => item.id === id);
    if (found) found.qty += 1;
    else {
      items.push({
        id,
        name: product.name || "商品",
        price: product.price ?? null,
        currency: product.currency || "HKD",
        store: product.store || "",
        image: product.image || "",
        url: product.url || "",
        sealed: {
          name: product.name ?? null,
          store: product.store ?? null,
          price: product.price ?? null,
          currency: product.currency ?? null,
          url: product.url ?? null,
          image: product.image ?? null,
        },
        sig: product.sig || "",
        qty: 1,
      });
    }
    save(items);
    return items;
  }

  function has(product) {
    return qtyOf(product) > 0;
  }

  function qtyOf(product) {
    const found = load().find((item) => item.id === idOf(product));
    return found ? Number(found.qty) || 1 : 0;
  }

  function setQty(product, qty) {
    const id = idOf(product);
    const next = Math.floor(Number(qty));
    if (!Number.isFinite(next) || next < 1) {
      remove(id);
      return 0;
    }
    const items = load();
    const found = items.find((item) => item.id === id);
    if (!found) {
      add(product);
      const created = load();
      const item = created.find((entry) => entry.id === id);
      if (item) item.qty = next;
      save(created);
      return next;
    }
    found.qty = next;
    save(items);
    return next;
  }

  function remove(id) {
    const items = load().filter((item) => item.id !== id);
    save(items);
    return items;
  }

  function count() {
    return load().reduce((sum, item) => sum + (Number(item.qty) || 1), 0);
  }

  function removeMany(ids) {
    const drop = new Set(ids);
    const items = load().filter((item) => !drop.has(item.id));
    save(items);
    return items;
  }

  return { load, add, has, qtyOf, setQty, remove, removeMany, count, idOf };
})();
