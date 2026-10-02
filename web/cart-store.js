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
        qty: 1,
      });
    }
    save(items);
    return items;
  }

  function has(product) {
    const id = idOf(product);
    return load().some((item) => item.id === id);
  }

  function remove(id) {
    const items = load().filter((item) => item.id !== id);
    save(items);
    return items;
  }

  function count() {
    return load().reduce((sum, item) => sum + (Number(item.qty) || 1), 0);
  }

  return { load, add, has, remove, count, idOf };
})();
