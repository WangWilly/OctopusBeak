(function () {
  function moneyText(value, currency) {
    return (currency ? currency + " " : "") + value;
  }

  function formatRows(rows, emptyLabel) {
    if (!rows || !rows.length) {
      return '<tr><td colspan="5">' + emptyLabel + '</td></tr>';
    }

    return rows.map(function (row) {
      return '<tr>' +
        '<td>' + row.date + '</td>' +
        '<td>' + row.label + '</td>' +
        '<td>' + row.type + '</td>' +
        '<td class="right money" data-hidden="----">' + moneyText(row.amount, row.currency) + '</td>' +
        '<td class="right">' + (row.note || "--") + '</td>' +
      '</tr>';
    }).join("");
  }

  function formatPositions(rows) {
    if (!rows || !rows.length) {
      return '<tr><td colspan="5">No asset positions for this account.</td></tr>';
    }

    return rows.map(function (row) {
      return '<tr>' +
        '<td>' + row.symbol + '</td>' +
        '<td>' + row.name + '</td>' +
        '<td class="right num">' + row.units + '</td>' +
        '<td class="right money" data-hidden="----">' + moneyText(row.value, row.currency) + '</td>' +
        '<td class="right ' + (row.change.indexOf("-") === 0 ? "bad" : "good") + '">' + row.change + '</td>' +
      '</tr>';
    }).join("");
  }

  function selectAccount(card) {
    var data = window.dashboardAccounts || {};
    var account = data[card.dataset.account];
    if (!account) return;

    document.querySelectorAll(".account-card").forEach(function (item) {
      item.classList.toggle("selected", item === card);
    });

    var title = document.querySelector("[data-detail-title]");
    var meta = document.querySelector("[data-detail-meta]");
    var value = document.querySelector("[data-detail-value]");
    var detailPane = document.querySelector(".detail-pane");
    var txButton = detailPane ? detailPane.querySelector("[data-open-transactions]") : null;
    var positionsButton = detailPane ? detailPane.querySelector("[data-open-positions]") : null;

    if (title) title.textContent = account.name;
    if (meta) meta.textContent = account.institution + " / " + account.typeLabel;
    if (value) {
      value.dataset.original = moneyText(account.value, account.currency);
      value.textContent = value.dataset.original;
    }
    if (txButton) txButton.dataset.account = card.dataset.account;
    if (positionsButton) {
      positionsButton.dataset.account = card.dataset.account;
      positionsButton.hidden = !account.positions || !account.positions.length;
      positionsButton.parentElement.classList.toggle("single", positionsButton.hidden);
    }
  }

  function applyFilters() {
    var filter = document.querySelector(".filter-btn[aria-pressed='true']");
    var filterValue = filter ? filter.dataset.filter : "all";
    var search = (document.querySelector("[data-search]") || {}).value || "";
    var query = search.trim().toLowerCase();
    var visible = 0;

    document.querySelectorAll(".account-card").forEach(function (card) {
      var typeMatch = filterValue === "all" || card.dataset.type === filterValue;
      var text = card.textContent.toLowerCase();
      var searchMatch = !query || text.indexOf(query) !== -1;
      var show = typeMatch && searchMatch;
      card.hidden = !show;
      card.style.display = show
        ? (card.tagName === "TR" ? "table-row" : "")
        : "none";
      if (show) visible += 1;
    });

    var empty = document.querySelector("[data-empty]");
    if (empty) empty.classList.toggle("show", visible === 0);

    var selected = document.querySelector(".account-card.selected:not([hidden])");
    if (!selected) {
      var first = document.querySelector(".account-card:not([hidden])");
      if (first) selectAccount(first);
    }
  }

  function openModal(kind, accountId) {
    var data = window.dashboardAccounts || {};
    var account = data[accountId];
    var modal = document.querySelector('[data-modal="' + kind + '"]');
    if (!account || !modal) return;

    var title = modal.querySelector("[data-modal-title]");
    var subtitle = modal.querySelector("[data-modal-subtitle]");
    var body = modal.querySelector("[data-modal-rows]");

    if (title) title.textContent = account.name + (kind === "positions" ? " Positions" : " Transactions");
    if (subtitle) subtitle.textContent = account.institution + " / " + account.typeLabel;
    if (body) {
      body.innerHTML = kind === "positions"
        ? formatPositions(account.positions)
        : formatRows(account.transactions, "No transactions for this account.");
      syncMoneyVisibility();
    }

    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
  }

  function closeModal(button) {
    var modal = button.closest(".modal");
    if (!modal) return;
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
  }

  function syncMoneyVisibility() {
    document.querySelectorAll(".money").forEach(function (item) {
      if (!item.dataset.original) item.dataset.original = item.textContent;
      item.textContent = item.dataset.original;
    });
  }

  function initValues() {
    syncMoneyVisibility();
    document.querySelectorAll("[data-toggle-values]").forEach(function (button) {
      button.addEventListener("click", function () {
        document.body.classList.toggle("values-hidden");
        var hidden = document.body.classList.contains("values-hidden");
        syncMoneyVisibility();
        document.querySelectorAll("[data-toggle-values]").forEach(function (toggle) {
          toggle.setAttribute("aria-pressed", String(!hidden));
          var label = toggle.querySelector("[data-switch-label]");
          if (label) label.textContent = "Values Visible";
        });
      });
    });
  }

  function initFilters() {
    document.querySelectorAll(".filter-btn").forEach(function (button) {
      button.addEventListener("click", function () {
        document.querySelectorAll(".filter-btn").forEach(function (item) {
          item.setAttribute("aria-pressed", "false");
        });
        button.setAttribute("aria-pressed", "true");
        applyFilters();
      });
    });

    var search = document.querySelector("[data-search]");
    if (search) search.addEventListener("input", applyFilters);
  }

  function initAccounts() {
    document.querySelectorAll(".account-card").forEach(function (card) {
      card.addEventListener("click", function () {
        selectAccount(card);
      });
    });

    var first = document.querySelector(".account-card.selected") || document.querySelector(".account-card");
    if (first) selectAccount(first);
  }

  function initModals() {
    document.querySelectorAll("[data-open-transactions]").forEach(function (button) {
      button.addEventListener("click", function () {
        openModal("transactions", button.dataset.account);
      });
    });

    document.querySelectorAll("[data-open-positions]").forEach(function (button) {
      button.addEventListener("click", function () {
        openModal("positions", button.dataset.account);
      });
    });

    document.querySelectorAll("[data-close-modal]").forEach(function (button) {
      button.addEventListener("click", function () {
        closeModal(button);
      });
    });

    document.querySelectorAll(".modal").forEach(function (modal) {
      modal.addEventListener("click", function (event) {
        if (event.target === modal) {
          modal.classList.remove("open");
          modal.setAttribute("aria-hidden", "true");
        }
      });
    });

    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape") return;
      document.querySelectorAll(".modal.open").forEach(function (modal) {
        modal.classList.remove("open");
        modal.setAttribute("aria-hidden", "true");
      });
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    initValues();
    initFilters();
    initAccounts();
    initModals();
    applyFilters();
  });
})();
