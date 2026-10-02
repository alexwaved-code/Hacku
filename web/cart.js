const cart = document.querySelector("#cart");

function money(amount, currency) {
  if (amount == null || Number.isNaN(Number(amount))) return "價格見商店";
  try {
    return new Intl.NumberFormat("zh-HK", { style: "currency", currency: currency || "HKD" }).format(amount);
  } catch {
    return `${currency || ""} ${amount}`;
  }
}

function render() {
  const items = HackuCart.load();
  cart.replaceChildren();
  if (!items.length) {
    cart.append(el("p", "empty", "購物車是空的。回到對話，在推薦商品上按「加入購物車」。"));
    return;
  }

  const list = el("ul", "cart-list");
  let known = 0;
  let missing = false;
  for (const item of items) {
    const qty = Number(item.qty) || 1;
    if (item.price == null) missing = true;
    else known += Number(item.price) * qty;
    const picture = item.image ? el("img", "cart-pic") : el("div", "cart-pic");
    if (item.image) {
      picture.src = item.image;
      picture.alt = "";
      picture.referrerPolicy = "no-referrer";
    }
    const remove = el("button", "pill", "移除");
    remove.type = "button";
    remove.addEventListener("click", () => {
      HackuCart.remove(item.id);
      render();
    });
    const title = item.url
      ? el("a", "cart-name", item.name)
      : el("p", "cart-name", item.name);
    if (item.url) {
      title.href = item.url;
      title.target = "_blank";
      title.rel = "noopener noreferrer";
    }
    list.append(
      row(
        picture,
        el("div", "cart-info", title, el("p", "store", item.store || ""), el("p", "price", `${money(item.price, item.currency)} × ${qty}`)),
        remove
      )
    );
  }
  cart.append(list);
  const total = missing && known === 0 ? "部分商品價格見商店" : missing ? `${money(known, "HKD")}（部分價格見商店）` : money(known, "HKD");
  cart.append(el("p", "cart-total", `合計 ${total}`));
}

function row(...children) {
  return el("li", "cart-row", ...children);
}

function el(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

render();
