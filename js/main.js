/* global L, supabase */
(function () {
    "use strict";

    // ============== Service Worker (PWA) ==============
    if ("serviceWorker" in navigator) {
        window.addEventListener("load", function () {
            navigator.serviceWorker.register("./sw.js")
                .then(function (reg) {
                    console.log("[PWA] Service Worker registrado", reg.scope);

                    // Cuando se instala un SW nuevo, mostramos un banner
                    // informando al usuario. Si no actúa en 10 s, lo aplicamos solo.
                    function activarSiInstalado(worker) {
                        if (!worker) return;
                        if (worker.state === "installed" && navigator.serviceWorker.controller) {
                            mostrarBannerActualizar(worker);
                        }
                    }
                    // Caso 1: ya hay un worker en "waiting" al cargar
                    activarSiInstalado(reg.waiting);
                    // Caso 2: detectamos una actualización mientras la app está abierta
                    reg.addEventListener("updatefound", function () {
                        const nuevo = reg.installing;
                        if (!nuevo) return;
                        nuevo.addEventListener("statechange", function () {
                            activarSiInstalado(nuevo);
                        });
                    });
                    // Revisar actualizaciones cuando la pestaña vuelve a primer plano
                    document.addEventListener("visibilitychange", function () {
                        if (document.visibilityState === "visible") {
                            reg.update().catch(function () { /* sin red, ignorar */ });
                        }
                    });
                })
                .catch(function (err) { console.warn("[PWA] SW falló:", err); });
            // Cuando el SW activo cambia (auto-update), recargamos una vez
            navigator.serviceWorker.addEventListener("controllerchange", function () {
                if (window._actualizandoSW) return;
                window._actualizandoSW = true;
                window.location.reload();
            });
        });
    }

    function mostrarBannerActualizar(worker) {
        if (document.getElementById("updateBanner")) return; // ya hay uno
        const banner = document.createElement("div");
        banner.id = "updateBanner";
        banner.className = "update-banner";
        banner.innerHTML = `
            <span id="updateMsg">Nueva versión disponible · se actualizará en <b id="updateCount">10</b>s</span>
            <button type="button" class="btn-update">Actualizar ahora</button>
        `;
        document.body.appendChild(banner);

        let restante = 10;
        const countEl = banner.querySelector("#updateCount");
        const tick = setInterval(function () {
            restante -= 1;
            if (countEl) countEl.textContent = String(Math.max(0, restante));
            if (restante <= 0) {
                clearInterval(tick);
                aplicar();
            }
        }, 1000);

        function aplicar() {
            clearInterval(tick);
            const msg = document.getElementById("updateMsg");
            if (msg) msg.textContent = "Actualizando...";
            const btn = banner.querySelector(".btn-update");
            if (btn) btn.disabled = true;
            try { worker.postMessage("SKIP_WAITING"); } catch (_) { /* noop */ }
        }

        banner.querySelector("button").addEventListener("click", aplicar);
    }

    const cfg = window.APP_CONFIG;

    // Modo consulta: página de solo lectura para conductores.
    // Se activa con window.MODO_CONSULTA = true en el HTML (indexx.html).
    // Sin acciones de despacho/asignación; lista única ordenada por hora de llegada.
    const MODO_CONSULTA = !!window.MODO_CONSULTA;

    // Quitar el splash y pintar la versión en cuanto el DOM esté listo.
    // Con scripts deferred esto se ejecuta justo antes de DOMContentLoaded.
    function listoUiInicial() {
        const v = document.getElementById("appVersion");
        if (v && cfg && cfg.APP_VERSION) v.textContent = cfg.APP_VERSION;
        document.body.classList.add("app-ready");
        const splash = document.getElementById("appSplash");
        if (splash) setTimeout(function () { splash.remove(); }, 250);
    }
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", listoUiInicial, { once: true });
    } else {
        listoUiInicial();
    }
    if (!cfg || !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
        document.getElementById("tablaBox").innerHTML =
            '<div class="loading">Falta configuración en config.js</div>';
        return;
    }

    const client = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
        auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: false,
        },
    });

    let currentUser = null;
    let appStarted = false;

    // Estado global
    let rows = [];
    let selectedItin = null; // null = todos
    let map = null;
    let markersLayer = null;
    let markersByVehicleId = {};
    let realtimeChannel = null;
    let reconnectTimer = null;
    let reconnectDelay = 2000; // ms, sube con backoff hasta 30s
    let activeTab = "mapa";
    let despachos = [];
    let despachosFiltroActivos = true;
    let despachosLoading = false;
    let vehiculos = [];
    let vehiculosLoading = null;
    let conductores = [];
    let conductoresLoading = null;
    let realizados = [];
    let realizadosFiltroActivos = true;
    let realizadosChannel = null;
    let realizadosPage = 1;
    let realizadosSearch = "";
    let realizadosItinSel = null; // itinerario seleccionado en los chips (modo consulta)
    const REALIZADOS_PAGE_SIZE = 25;
    const CANCEL_WINDOW_MS = 60 * 60 * 1000; // 1 hora

    // ============== Tabs ==============
    function initTabs() {
        document.querySelectorAll(".tab").forEach(function (btn) {
            btn.addEventListener("click", function () {
                const target = btn.getAttribute("data-tab");
                setActiveTab(target);
            });
        });
    }

    function setActiveTab(name) {
        activeTab = name;
        document.querySelectorAll(".tab").forEach(function (btn) {
            const isActive = btn.getAttribute("data-tab") === name;
            btn.classList.toggle("active", isActive);
            btn.setAttribute("aria-selected", isActive ? "true" : "false");
        });
        document.querySelectorAll(".pane").forEach(function (pane) {
            pane.classList.toggle("active", pane.id === "pane" + capitalize(name));
        });
        // Leaflet necesita invalidateSize si el contenedor cambió de visibilidad
        if (name === "mapa" && map) {
            setTimeout(function () {
                map.invalidateSize();
                if (!window._fitDone && rows.length) {
                    autoFitMap();
                }
            }, 50);
        }
        // Cargar despachos cuando se entra a esa pestaña (si no se ha cargado todavía)
        if (name === "despachos" && !despachos.length && !despachosLoading) {
            cargarDespachos();
        }
        if (name === "realizados") {
            cargarRealizados();
        }
    }

    function capitalize(s) {
        return s.charAt(0).toUpperCase() + s.slice(1);
    }

    // ============== Mapa ==============
    function initMap() {
        map = L.map("map", { zoomControl: true }).setView(
            [cfg.MAP_CENTER.lat, cfg.MAP_CENTER.lng],
            cfg.MAP_ZOOM
        );
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            maxZoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        }).addTo(map);
        markersLayer = L.layerGroup().addTo(map);
    }

    function busMarkerIcon(row) {
        const cls = row.listo ? "bus-marker" : "bus-marker bus-espera";
        const label = escapeHtml(String(row.interno || row.vehicle_id || ""));
        return L.divIcon({
            className: "",
            html: `<div class="${cls}">${label}</div>`,
            iconSize: [36, 36],
            iconAnchor: [18, 18],
        });
    }

    function autoFitMap() {
        const bounds = [];
        rows.forEach(function (r) {
            if (r.lat != null && r.lon != null) {
                const lat = Number(r.lat), lon = Number(r.lon);
                if (isFinite(lat) && isFinite(lon)) bounds.push([lat, lon]);
            }
        });
        if (bounds.length) {
            map.fitBounds(bounds, { padding: [60, 60], maxZoom: 16 });
            window._fitDone = true;
        }
    }

    function renderMap() {
        if (!map) return;
        markersLayer.clearLayers();
        markersByVehicleId = {};
        rows.forEach(function (row) {
            if (row.lat == null || row.lon == null) return;
            const lat = Number(row.lat);
            const lon = Number(row.lon);
            if (!isFinite(lat) || !isFinite(lon)) return;
            const marker = L.marker([lat, lon], { icon: busMarkerIcon(row) });
            marker.bindPopup(popupHtml(row));
            marker.addTo(markersLayer);
            markersByVehicleId[row.vehicle_id] = marker;
        });
        if (!window._fitDone && activeTab === "mapa") {
            autoFitMap();
        }
    }

    function popupHtml(row) {
        const hace = humanizeAge(row.hora_llegada);
        const estado = row.listo ? "LISTO" : "ESPERA";
        const cls = row.listo ? "listo" : "espera";
        return `
            <div style="font-size:13px;min-width:180px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
                <div style="font-weight:900;color:#2b33ff;font-size:16px;margin-bottom:6px;">
                    Bus ${escapeHtml(row.interno || row.vehicle_id || "")}
                </div>
                <div style="margin-bottom:4px;"><b>${escapeHtml(row.itinerario || "")}</b></div>
                <div style="margin-bottom:4px;">Posición: <b>#${row.posicion ?? "-"}</b></div>
                <div style="margin-bottom:4px;">Llegada: <b>${escapeHtml(formatHora(row.hora_llegada))}</b></div>
                <div style="margin-bottom:6px;color:#6b7280;font-size:12px;">${escapeHtml(hace)}</div>
                <span class="estado-pill ${cls}">${estado}</span>
            </div>
        `;
    }

    // ============== Stats ==============
    function setText(id, value) {
        const el = document.getElementById(id);
        if (el) el.textContent = String(value);
    }

    function updateStats() {
        const total = rows.length;
        const listos = rows.filter(function (r) { return r.listo; }).length;
        const espera = total - listos;

        // En modo consulta solo se muestra el Total; los demás pueden no existir.
        setText("statTotal", total);
        setText("statListos", listos);
        setText("statEspera", espera);

        setText("miniTotal", total);
        setText("miniListos", listos);
        setText("miniEspera", espera);

        setText("tabListasBadge", total);
    }

    // ============== Tabla y chips ==============
    function renderChipsAndTable() {
        if (MODO_CONSULTA) { renderConsultaTable(); return; }
        const grupos = {};
        rows.forEach(function (r) {
            const k = r.itinerario || "Sin itinerario";
            (grupos[k] = grupos[k] || []).push(r);
        });
        Object.values(grupos).forEach(function (arr) {
            arr.sort(function (a, b) {
                return (a.posicion || 9999) - (b.posicion || 9999);
            });
        });

        const itins = Object.keys(grupos).sort();
        const total = rows.length;

        // Chips
        if (selectedItin && !itins.includes(selectedItin)) selectedItin = null;
        const chipsBox = document.getElementById("chips");
        const chipsHtml = [
            `<button type="button" class="chip ${selectedItin === null ? "active" : ""}" data-itin="">
                Todos<span class="chip-count">${total}</span>
            </button>`,
        ].concat(itins.map(function (itin) {
            return `<button type="button" class="chip ${selectedItin === itin ? "active" : ""}" data-itin="${escapeHtml(itin)}">
                ${escapeHtml(itin)}<span class="chip-count">${grupos[itin].length}</span>
            </button>`;
        })).join("");
        chipsBox.innerHTML = chipsHtml;
        chipsBox.querySelectorAll(".chip").forEach(function (btn) {
            btn.addEventListener("click", function () {
                const val = btn.getAttribute("data-itin");
                selectedItin = val ? val : null;
                renderChipsAndTable();
            });
        });

        // Tabla
        const visible = selectedItin === null ? itins : itins.filter(function (i) { return i === selectedItin; });
        const tablaBox = document.getElementById("tablaBox");
        if (!visible.length) {
            tablaBox.innerHTML = '<div class="loading">Sin buses en la geocerca</div>';
            return;
        }
        tablaBox.innerHTML = visible.map(function (itin) {
            const items = grupos[itin];
            const filas = items.map(function (r) {
                const hace = humanizeAge(r.hora_llegada);
                const estadoCls = r.listo ? "listo" : "espera";
                const estadoTxt = r.listo ? "LISTO" : "ESPERA";
                return `
                    <tr class="bus-row" data-vehicle-id="${escapeHtml(r.vehicle_id || "")}" tabindex="0" role="button" aria-label="Asignar itinerario al bus ${escapeHtml(r.interno || "")}">
                        <td class="pos">${r.posicion ?? "-"}</td>
                        <td class="hora">${escapeHtml(formatHora(r.hora_llegada))}</td>
                        <td class="hace">${escapeHtml(hace)}</td>
                        <td class="interno">${escapeHtml(r.interno || "")}</td>
                        <td><span class="estado-pill ${estadoCls}">${estadoTxt}</span></td>
                        <td>
                            <button type="button" class="btn-assign" data-action="assign" data-vehicle-id="${escapeHtml(r.vehicle_id || "")}">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                                    <path d="M12 5v14m-7-7h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
                                </svg>
                                Asignar
                            </button>
                        </td>
                    </tr>
                `;
            }).join("");
            return `
                <div class="itin-group">
                    <div class="itin-head">
                        ${escapeHtml(itin)}
                        <span class="itin-count">${items.length}</span>
                    </div>
                    <table class="arrivals">
                        <thead>
                            <tr>
                                <th>#</th>
                                <th>Hora</th>
                                <th>Hace</th>
                                <th>Bus</th>
                                <th>Estado</th>
                                <th>Acción</th>
                            </tr>
                        </thead>
                        <tbody>${filas}</tbody>
                    </table>
                </div>
            `;
        }).join("");

        // Click/tap en cualquier parte de la fila abre el modal de asignar.
        // Esto resuelve móviles donde la columna del botón está oculta.
        function abrirDesdeFila(tr) {
            const vid = tr.getAttribute("data-vehicle-id");
            if (!vid) return;
            const row = rows.find(function (r) { return r.vehicle_id === vid; });
            if (row) openAssignModal(row);
        }
        tablaBox.querySelectorAll("tr.bus-row").forEach(function (tr) {
            tr.addEventListener("click", function () { abrirDesdeFila(tr); });
            tr.addEventListener("keydown", function (ev) {
                if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    abrirDesdeFila(tr);
                }
            });
        });
    }

    // ============== Tabla de consulta (solo lectura, conductores) ==============
    // Una sola lista con todas las llegadas ordenadas por hora de llegada.
    // Muestra el itinerario por fila y no permite ninguna acción de despacho.
    function renderConsultaTable() {
        const chipsBox = document.getElementById("chips");
        if (chipsBox) { chipsBox.innerHTML = ""; chipsBox.hidden = true; }

        const tablaBox = document.getElementById("tablaBox");
        if (!tablaBox) return;

        if (!rows.length) {
            tablaBox.innerHTML = '<div class="loading">Sin buses en la geocerca</div>';
            return;
        }

        // Ordenar por hora de llegada (más antigua primero, igual que la posición FIFO)
        const ordenadas = rows.slice().sort(function (a, b) {
            const ta = new Date(a.hora_llegada).getTime() || 0;
            const tb = new Date(b.hora_llegada).getTime() || 0;
            return ta - tb;
        });

        // Un bus que lleva más de 3 horas en la lista probablemente tiene un
        // problema de GPS (no se actualizó la salida): hay que revisarlo.
        const ahora = Date.now();
        let cuentaGps = 0;
        const filas = ordenadas.map(function (r, i) {
            const hace = humanizeAge(r.hora_llegada);
            const llegadaMs = new Date(r.hora_llegada).getTime();
            const horas = Number.isFinite(llegadaMs) ? (ahora - llegadaMs) / 3600000 : 0;
            const revisarGps = horas > 3;
            if (revisarGps) cuentaGps++;
            const gpsBadge = revisarGps
                ? ' <span class="estado-pill gps-alert">⚠️ REVISAR GPS</span>'
                : '';
            return `
                <tr class="${revisarGps ? "fila-gps-alert" : ""}">
                    <td class="pos">${i + 1}</td>
                    <td class="hora">${escapeHtml(formatHora(r.hora_llegada))}</td>
                    <td class="hace">${escapeHtml(hace)}</td>
                    <td class="interno">${escapeHtml(r.interno || "")}${gpsBadge}</td>
                    <td>${escapeHtml(r.itinerario || "Sin itinerario")}</td>
                </tr>
            `;
        }).join("");

        // Aviso resumen arriba de la tabla si hay buses por revisar.
        const avisoGps = cuentaGps
            ? `<div class="gps-banner">⚠️ ${cuentaGps} ${cuentaGps === 1 ? "bus lleva" : "buses llevan"} más de 3 horas — revisar por GPS</div>`
            : "";

        tablaBox.innerHTML = avisoGps + `
            <div class="itin-group">
                <table class="arrivals consulta-arrivals">
                    <thead>
                        <tr>
                            <th>#</th>
                            <th>Hora</th>
                            <th>Hace</th>
                            <th>Bus</th>
                            <th>Itinerario</th>
                        </tr>
                    </thead>
                    <tbody>${filas}</tbody>
                </table>
            </div>
        `;
    }

    // ============== Modal asignar itinerario ==============
    function openAssignModal(row) {
        const modal = document.getElementById("assignModal");
        document.getElementById("assignBus").textContent = row.interno || row.vehicle_id || "—";
        document.getElementById("assignDriver").textContent = row.driver_id || "—";
        const select = document.getElementById("assignItin");
        const EXCLUIDOS = ["4413"]; // Aeropuerto-Exposiciones
        const itins = (cfg.ITINERARIOS || []).filter(function (i) {
            return i.grupo === "AEROPUERTO" && !EXCLUIDOS.includes(i.id);
        });
        select.innerHTML =
            '<option value="">— Seleccionar itinerario —</option>' +
            itins.map(function (i) {
                return `<option value="${escapeHtml(i.id)}">${escapeHtml(i.nombre)}</option>`;
            }).join("");
        // Preseleccionar si el itinerario actual del bus coincide con alguno conocido
        const match = itins.find(function (i) { return i.nombre === row.itinerario; });
        if (match) select.value = match.id;
        document.getElementById("assignObs").value = "";
        document.getElementById("assignError").hidden = true;
        document.getElementById("assignSubmit").dataset.vehicleId = row.vehicle_id || "";
        document.getElementById("assignSubmit").dataset.driverId = row.driver_id || "";
        modal.hidden = false;
    }

    function closeAssignModal() {
        document.getElementById("assignModal").hidden = true;
    }

    async function submitAssign(ev) {
        ev.preventDefault();
        const submitBtn = document.getElementById("assignSubmit");
        const errorBox = document.getElementById("assignError");
        const mId = submitBtn.dataset.vehicleId;
        const drvId = submitBtn.dataset.driverId;
        const itinerary = document.getElementById("assignItin").value;
        const observaciones = document.getElementById("assignObs").value.trim();

        if (!mId) {
            errorBox.textContent = "Falta el ID del bus.";
            errorBox.hidden = false;
            return;
        }
        if (!itinerary) {
            errorBox.textContent = "Selecciona un itinerario.";
            errorBox.hidden = false;
            return;
        }
        if (!drvId) {
            errorBox.textContent = "Este bus no tiene conductor registrado.";
            errorBox.hidden = false;
            return;
        }

        // Datos del bus seleccionado (para guardar en despachos_realizados)
        const row = rows.find(function (r) { return r.vehicle_id === mId; });
        const itinObj = (cfg.ITINERARIOS || []).find(function (i) { return i.id === itinerary; });

        // Confirmación previa al envío a Sonar
        const driverNombre = document.getElementById("assignDriver")?.textContent || "—";
        const detalleHtml = `
            <div><strong>Bus:</strong> ${escapeHtml(row?.interno || mId)}</div>
            <div><strong>Conductor:</strong> ${escapeHtml(driverNombre)}</div>
            <div><strong>Itinerario:</strong> ${escapeHtml(itinObj?.nombre || itinerary)}</div>
            ${observaciones ? `<div><strong>Observación:</strong> ${escapeHtml(observaciones)}</div>` : ""}
        `;
        const okDespachar = await mostrarConfirmacion({
            titulo: "Confirmar despacho",
            mensaje: "Se enviará la orden a Sonar y quedará registrada en Despachos realizados.",
            detalle: detalleHtml,
            textoConfirmar: "Sí, despachar",
            textoCancelar: "Revisar",
            tipo: "info",
        });
        if (!okDespachar) return;

        errorBox.hidden = true;
        submitBtn.disabled = true;
        submitBtn.textContent = "Enviando...";

        try {
            const resp = await fetch(cfg.SONAR_DISPATCH_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    apikey: cfg.SUPABASE_ANON_KEY,
                    Authorization: "Bearer " + cfg.SUPABASE_ANON_KEY,
                },
                body: JSON.stringify({ mId, itinerary, drvId, observaciones }),
            });
            const data = await resp.json().catch(function () { return {}; });
            if (!resp.ok || data.success === false) {
                throw new Error(data.message || data.error || ("HTTP " + resp.status));
            }

            const regId = data?.data?.regId || "";
            // Guardar despacho en tabla despachos_realizados (si tenemos regId)
            if (regId) {
                try {
                    const { error } = await client.from(cfg.TABLA_REALIZADOS).insert({
                        reg_id: regId,
                        vehicle_id: mId,
                        interno: row?.interno || mId,
                        placa: "",
                        itinerario_id: itinerary,
                        itinerario: itinObj?.nombre || "",
                        driver_id: drvId,
                        observaciones: observaciones,
                        pasajeros: 0,
                        created_by: currentUser?.id || null,
                    });
                    if (error) console.warn("Insert despachos_realizados falló:", error);
                } catch (e) {
                    console.warn("No se pudo guardar el despacho local:", e);
                }
            }

            closeAssignModal();
            showToast("ok", `Despacho asignado${regId ? " · regId: " + regId : ""}`);
        } catch (err) {
            errorBox.textContent = "Error: " + (err.message || String(err));
            errorBox.hidden = false;
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = "Asignar";
        }
    }

    function initModal() {
        const modal = document.getElementById("assignModal");
        modal.querySelectorAll("[data-close]").forEach(function (btn) {
            btn.addEventListener("click", closeAssignModal);
        });
        modal.addEventListener("click", function (ev) {
            if (ev.target === modal) closeAssignModal();
        });
        document.addEventListener("keydown", function (ev) {
            if (ev.key === "Escape" && !modal.hidden) closeAssignModal();
        });
        document.getElementById("assignForm").addEventListener("submit", submitAssign);
    }

    // ============== Toast ==============
    let toastTimer = null;
    function showToast(kind, msg) {
        const toast = document.getElementById("toast");
        toast.className = "toast toast-" + kind;
        toast.textContent = "";
        const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        icon.setAttribute("width", "18");
        icon.setAttribute("height", "18");
        icon.setAttribute("viewBox", "0 0 24 24");
        icon.setAttribute("fill", "none");
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("stroke", "currentColor");
        path.setAttribute("stroke-width", "2.5");
        path.setAttribute("stroke-linecap", "round");
        path.setAttribute("stroke-linejoin", "round");
        path.setAttribute("d", kind === "ok" ? "M5 13l4 4L19 7" : "M12 9v4m0 4h.01M12 3a9 9 0 100 18 9 9 0 000-18z");
        icon.appendChild(path);
        toast.appendChild(icon);
        toast.appendChild(document.createTextNode(msg));
        toast.hidden = false;
        requestAnimationFrame(function () { toast.classList.add("show"); });
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
            toast.classList.remove("show");
            setTimeout(function () { toast.hidden = true; }, 250);
        }, 4500);
    }

    // ============== Modal de confirmación ==============
    function mostrarConfirmacion(opts) {
        opts = opts || {};
        return new Promise(function (resolve) {
            const modal = document.getElementById("confirmModal");
            const titleEl = document.getElementById("confirmTitle");
            const msgEl = document.getElementById("confirmMessage");
            const detailEl = document.getElementById("confirmDetail");
            const iconEl = document.getElementById("confirmIcon");
            const btnOk = document.getElementById("confirmAccept");
            const btnCancel = document.getElementById("confirmCancel");
            if (!modal) {
                // Fallback si por alguna razón no está montado
                resolve(window.confirm(opts.mensaje || "¿Confirmar?"));
                return;
            }

            titleEl.textContent = opts.titulo || "¿Confirmar acción?";
            msgEl.textContent = opts.mensaje || "Esta acción se realizará a continuación.";

            if (opts.detalle) {
                detailEl.innerHTML = opts.detalle;
                detailEl.hidden = false;
            } else {
                detailEl.innerHTML = "";
                detailEl.hidden = true;
            }

            const tipo = opts.tipo || "warn"; // warn | danger | info
            iconEl.className = "confirm-icon confirm-icon-" + tipo;

            btnOk.textContent = opts.textoConfirmar || "Confirmar";
            btnCancel.textContent = opts.textoCancelar || "Cancelar";
            btnOk.className = "btn " + (tipo === "danger" ? "btn-danger" : "btn-primary");

            function cerrar(valor) {
                modal.hidden = true;
                btnOk.removeEventListener("click", onOk);
                btnCancel.removeEventListener("click", onCancel);
                modal.removeEventListener("click", onBackdrop);
                document.removeEventListener("keydown", onKey);
                resolve(valor);
            }
            function onOk() { cerrar(true); }
            function onCancel() { cerrar(false); }
            function onBackdrop(ev) { if (ev.target === modal) cerrar(false); }
            function onKey(ev) {
                if (ev.key === "Escape") cerrar(false);
                if (ev.key === "Enter") cerrar(true);
            }

            btnOk.addEventListener("click", onOk);
            btnCancel.addEventListener("click", onCancel);
            modal.addEventListener("click", onBackdrop);
            document.addEventListener("keydown", onKey);

            modal.hidden = false;
            setTimeout(function () { btnOk.focus(); }, 50);
        });
    }

    // ============== Utilidades ==============
    function escapeHtml(s) {
        return String(s == null ? "" : s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function formatHora(iso) {
        if (!iso) return "";
        const d = new Date(iso);
        if (isNaN(d.getTime())) return String(iso);
        return d.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    }

    function humanizeAge(iso) {
        if (!iso) return "";
        const d = new Date(iso);
        if (isNaN(d.getTime())) return "";
        const mins = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60000));
        if (mins < 60) return `hace ${mins} min`;
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return `hace ${h} h ${m} min`;
    }

    function setConnection(state) {
        const el = document.getElementById("connection");
        el.className = "badge";
        if (state === "ok") {
            el.classList.add("badge-ok");
            el.textContent = "En vivo";
        } else if (state === "offline") {
            el.classList.add("badge-err");
            el.textContent = "Sin internet";
        } else if (state === "err") {
            el.classList.add("badge-err");
            el.textContent = "Sin conexión";
        } else if (state === "reconnecting") {
            el.classList.add("badge-warn");
            el.textContent = "Reconectando...";
        } else {
            el.classList.add("badge-warn");
            el.textContent = "Conectando...";
        }
    }

    function setLastUpdate() {
        document.getElementById("lastUpdate").textContent = new Date().toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" });
    }

    // ============== Despachos ==============
    function despachoIsoUtc(d) {
        // Sonar devuelve initDate/initTime en HORA LOCAL COLOMBIA (UTC-5),
        // a pesar de que su campo se llame "UTC_datetime". Marcamos -05:00
        // para que JS lo interprete bien sin importar la zona del navegador.
        const date = String(d.initDate || "").trim();
        const time = String(d.initTime || "").trim();
        if (!date) return null;
        const t = time || "00:00:00";
        return `${date}T${t}-05:00`;
    }

    function despachoEstado(d) {
        // lcanceled / lcanceledbyuser → cancelado
        // lrunning="true" → activo en ruta
        // lclose="true" + no cancelado → completado
        const canceled = String(d.lcanceled).toLowerCase() === "true" || String(d.lcanceledbyuser).toLowerCase() === "true";
        const running = String(d.lrunning).toLowerCase() === "true";
        const closed = String(d.lclose).toLowerCase() === "true";
        if (canceled) return { txt: "CANCELADO", cls: "cancelado" };
        if (running) return { txt: "EN RUTA", cls: "activo" };
        if (closed) return { txt: "COMPLETADO", cls: "listo" };
        return { txt: "PENDIENTE", cls: "espera" };
    }

    async function cargarDespachos() {
        if (despachosLoading) return;
        if (!navigator.onLine) {
            document.getElementById("despachosBox").innerHTML =
                '<div class="loading">Sin conexión. Conéctate a internet para ver despachos.</div>';
            return;
        }
        despachosLoading = true;
        const box = document.getElementById("despachosBox");
        const subtitle = document.getElementById("despachosSubtitle");
        if (subtitle) subtitle.textContent = "Cargando últimas " + cfg.DESPACHOS_LOOKBACK_HORAS + " horas...";
        try {
            const ahora = new Date();
            const inicio = new Date(ahora.getTime() - (cfg.DESPACHOS_LOOKBACK_HORAS || 5) * 60 * 60 * 1000);
            const resp = await fetch(cfg.SONAR_DESPACHOS_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    fecha_inicio: inicio.toISOString(),
                    fecha_fin: ahora.toISOString(),
                }),
            });
            const data = await resp.json();
            if (!resp.ok || !data.success) {
                throw new Error(data.message || "Error " + resp.status);
            }
            despachos = (data.despachos || []).slice();
            // Ordenar por hora desc (más reciente arriba)
            despachos.sort(function (a, b) {
                const ta = despachoIsoUtc(a) || "";
                const tb = despachoIsoUtc(b) || "";
                return tb.localeCompare(ta);
            });
            renderDespachos();
        } catch (err) {
            console.error(err);
            box.innerHTML = `<div class="loading">Error: ${escapeHtml(err.message || String(err))}</div>`;
            if (subtitle) subtitle.textContent = "Error al cargar";
        } finally {
            despachosLoading = false;
        }
    }

    function normalizarItinerario(s) {
        return String(s || "")
            .normalize("NFD")
            .replace(/[̀-ͯ]/g, "") // quita tildes
            .toLowerCase()
            .trim();
    }

    function renderDespachos() {
        const box = document.getElementById("despachosBox");
        const subtitle = document.getElementById("despachosSubtitle");
        const badge = document.getElementById("tabDespachosBadge");

        // Filtro por lista blanca de itinerarios (config.js)
        const permitidos = new Set((cfg.DESPACHOS_ITINERARIOS_PERMITIDOS || []).map(normalizarItinerario));
        const despachosFiltrados = permitidos.size
            ? despachos.filter(function (d) { return permitidos.has(normalizarItinerario(d.itDesc)); })
            : despachos;

        const visibles = despachosFiltroActivos
            ? despachosFiltrados.filter(function (d) {
                  const canceled = String(d.lcanceled).toLowerCase() === "true" || String(d.lcanceledbyuser).toLowerCase() === "true";
                  return !canceled;
              })
            : despachosFiltrados;

        if (badge) badge.textContent = String(visibles.length);

        if (subtitle) {
            const totalSinFiltro = despachos.length;
            const totalFiltrado = despachosFiltrados.length;
            const partes = [`${visibles.length} mostrados`];
            if (despachosFiltroActivos) partes.push(`${totalFiltrado} totales del itinerario`);
            if (permitidos.size) partes.push(`${totalSinFiltro} despachos totales`);
            partes.push(`últimas ${cfg.DESPACHOS_LOOKBACK_HORAS} h`);
            subtitle.textContent = partes.join(" · ");
        }

        if (!visibles.length) {
            box.innerHTML = '<div class="loading">No hay despachos en este rango</div>';
            return;
        }

        const filas = visibles.map(function (d) {
            const iso = despachoIsoUtc(d);
            const hora = iso ? formatHora(iso) : (d.initTime || "");
            const hace = iso ? humanizeAge(iso) : "";
            const estado = despachoEstado(d);
            return `
                <tr>
                    <td class="hora">${escapeHtml(hora)}</td>
                    <td class="hace">${escapeHtml(hace)}</td>
                    <td class="interno">
                        ${escapeHtml(d.mDesc || d.interno || "")}
                        <span class="placa-tag">${escapeHtml(d.mPlaca || d.placa || "")}</span>
                    </td>
                    <td>${escapeHtml(d.itDesc || "")}</td>
                    <td class="conductor-cell" title="${escapeHtml(d.drName || "")}">${escapeHtml(d.drName || "—")}</td>
                    <td><span class="estado-pill ${estado.cls}">${estado.txt}</span></td>
                </tr>
            `;
        }).join("");

        box.innerHTML = `
            <table class="arrivals">
                <thead>
                    <tr>
                        <th>Hora</th>
                        <th>Hace</th>
                        <th>Bus</th>
                        <th>Itinerario</th>
                        <th>Conductor</th>
                        <th>Estado</th>
                    </tr>
                </thead>
                <tbody>${filas}</tbody>
            </table>
        `;
    }

    // ============== Realizados (despachos_realizados) ==============
    // En modo consulta solo pedimos las columnas públicas (anon no tiene
    // permiso sobre las internas como driver_id/created_by/placa). La app de
    // operaciones (logueada) sigue pidiendo todo con "*".
    const COLUMNAS_REALIZADOS_CONSULTA =
        "created_at, interno, itinerario, itinerario_id, pasajeros, observaciones, estado, vehicle_id";

    async function cargarRealizados() {
        try {
            const { data, error } = await client
                .from(cfg.TABLA_REALIZADOS)
                .select(MODO_CONSULTA ? COLUMNAS_REALIZADOS_CONSULTA : "*")
                .order("created_at", { ascending: false })
                .limit(500);
            if (error) throw error;
            realizados = data || [];
            renderRealizados();
            if (MODO_CONSULTA) renderAlertas();
        } catch (err) {
            console.warn("Error cargando realizados:", err);
            const box = document.getElementById("realizadosBox");
            if (box) box.innerHTML = `<div class="loading">Error: ${escapeHtml(err.message || String(err))}</div>`;
        }
    }

    function suscribirRealizadosRealtime() {
        if (realizadosChannel) return;
        realizadosChannel = client
            .channel("despachos_realizados_changes")
            .on("postgres_changes", { event: "*", schema: "public", table: cfg.TABLA_REALIZADOS }, function (payload) {
                // En modo consulta: avisar a los conductores cuando entra un
                // despacho nuevo (INSERT) de un itinerario del grupo AEROPUERTO.
                // Las ediciones/cancelaciones y otros itinerarios no alertan.
                if (MODO_CONSULTA && payload && payload.eventType === "INSERT" &&
                    payload.new && esDespachoAeropuerto(payload.new)) {
                    notificarDespacho(payload.new);
                }
                cargarRealizados();
            })
            .subscribe();
    }

    function detenerRealizadosRealtime() {
        if (realizadosChannel) {
            try { client.removeChannel(realizadosChannel); } catch (_) {}
            realizadosChannel = null;
        }
    }

    // ============== Alerta de despacho en tiempo real (modo consulta) ==============
    let audioCtx = null;
    let audioDesbloqueado = false;

    // Los navegadores móviles bloquean el audio hasta que hay un gesto del usuario.
    // Lo "desbloqueamos" en el primer toque para poder sonar luego sin interacción.
    function desbloquearAudio() {
        if (audioDesbloqueado) return;
        try {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return;
            audioCtx = audioCtx || new AC();
            if (audioCtx.state === "suspended") audioCtx.resume();
            audioDesbloqueado = true;
        } catch (_) { /* noop */ }
    }

    function reproducirBeep() {
        try {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return;
            audioCtx = audioCtx || new AC();
            if (audioCtx.state === "suspended") audioCtx.resume();
            const t0 = audioCtx.currentTime;
            // Dos tonos cortos tipo "campana"
            [0, 0.2].forEach(function (off) {
                const osc = audioCtx.createOscillator();
                const gain = audioCtx.createGain();
                osc.type = "sine";
                osc.frequency.value = 880;
                gain.gain.setValueAtTime(0.0001, t0 + off);
                gain.gain.exponentialRampToValueAtTime(0.35, t0 + off + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, t0 + off + 0.18);
                osc.connect(gain).connect(audioCtx.destination);
                osc.start(t0 + off);
                osc.stop(t0 + off + 0.2);
            });
        } catch (_) { /* noop */ }
    }

    // Alarma: varias ráfagas de beep para que se oiga aunque haya ruido.
    function reproducirAlarma() {
        reproducirBeep();
        setTimeout(reproducirBeep, 650);
        setTimeout(reproducirBeep, 1300);
    }

    // ¿La app está instalada como PWA (modo standalone)?
    function appInstaladaPWA() {
        try {
            return window.matchMedia("(display-mode: standalone)").matches ||
                window.matchMedia("(display-mode: fullscreen)").matches ||
                window.navigator.standalone === true;
        } catch (_) { return false; }
    }

    function inyectarEstilosAlerta() {
        if (document.getElementById("despachoAlertStyles")) return;
        const st = document.createElement("style");
        st.id = "despachoAlertStyles";
        st.textContent =
            ".despacho-alert-backdrop{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,0.55);padding:24px;animation:da-fade .2s ease;}" +
            ".despacho-alert{background:#fff;border-radius:18px;max-width:420px;width:100%;padding:28px 24px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.3);border-top:6px solid #4f46e5;}" +
            ".despacho-alert .da-icon{width:64px;height:64px;margin:0 auto 14px;border-radius:50%;background:#eef2ff;display:flex;align-items:center;justify-content:center;animation:da-pulse 1s ease infinite;}" +
            ".despacho-alert h2{margin:0 0 6px;font-size:20px;color:#1e293b;}" +
            ".despacho-alert .da-bus{font-size:32px;font-weight:900;color:#4f46e5;margin:8px 0;}" +
            ".despacho-alert .da-itin{font-size:15px;color:#475569;margin-bottom:4px;}" +
            ".despacho-alert .da-hora{font-size:13px;color:#94a3b8;margin-bottom:18px;}" +
            ".despacho-alert button{background:#4f46e5;color:#fff;border:0;border-radius:10px;padding:12px 28px;font-size:15px;font-weight:700;cursor:pointer;width:100%;}" +
            "@keyframes da-fade{from{opacity:0;}to{opacity:1;}}" +
            "@keyframes da-pulse{0%,100%{transform:scale(1);}50%{transform:scale(1.12);}}";
        document.head.appendChild(st);
    }

    // ¿El despacho corresponde a un itinerario del grupo AEROPUERTO?
    // Solo esos disparan alerta para los conductores.
    function esDespachoAeropuerto(reg) {
        if (!reg) return false;
        // 1) Por id contra config.js (lo más fiable)
        const id = reg.itinerario_id != null ? String(reg.itinerario_id) : "";
        if (id) {
            const it = (cfg.ITINERARIOS || []).find(function (i) { return String(i.id) === id; });
            if (it) return String(it.grupo || "").toUpperCase() === "AEROPUERTO";
        }
        // 2) Respaldo: el nombre del itinerario empieza por "aeropuerto"
        return normalizarItinerario(reg.itinerario).indexOf("aeropuerto") === 0;
    }

    // Pide permiso de notificaciones del sistema (debe llamarse tras un gesto).
    function pedirPermisoNotificaciones() {
        try {
            if ("Notification" in window && Notification.permission === "default") {
                Notification.requestPermission();
            }
        } catch (_) { /* noop */ }
    }

    // ===== Pantalla de ayuda para los conductores =====
    function inyectarEstilosAyuda() {
        if (document.getElementById("ayudaStyles")) return;
        const st = document.createElement("style");
        st.id = "ayudaStyles";
        st.textContent =
            "#ayudaModal{position:fixed;inset:0;z-index:100002;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:18px;animation:da-fade .2s ease;}" +
            "#ayudaModal .ay-card{background:#fff;border-radius:20px;max-width:440px;width:100%;max-height:88vh;overflow-y:auto;padding:26px 22px;box-shadow:0 24px 70px rgba(0,0,0,.35);}" +
            "#ayudaModal h2{margin:0 0 6px;font-size:21px;color:#1e293b;font-weight:800;}" +
            "#ayudaModal .ay-intro{margin:0 0 18px;font-size:14px;color:#64748b;}" +
            "#ayudaModal h3{margin:18px 0 6px;font-size:15px;color:#4f46e5;font-weight:800;}" +
            "#ayudaModal p{margin:0 0 8px;font-size:14px;color:#334155;line-height:1.5;}" +
            "#ayudaModal ul{margin:0 0 8px;padding-left:18px;}" +
            "#ayudaModal li{font-size:14px;color:#334155;line-height:1.7;}" +
            "#ayudaModal .ay-note{background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;border-radius:10px;padding:10px 12px;font-size:13px;margin-top:6px;}" +
            "#ayudaModal .ay-ok{background:#eef2ff;border:1px solid #c7d2fe;color:#3730a3;border-radius:10px;padding:10px 12px;font-size:13px;margin-top:6px;}" +
            "#ayudaModal button.ay-close{margin-top:20px;background:#4f46e5;color:#fff;border:0;border-radius:12px;padding:14px;font-size:16px;font-weight:800;cursor:pointer;width:100%;}";
        document.head.appendChild(st);
    }

    function mostrarAyuda() {
        if (document.getElementById("ayudaModal")) return;
        inyectarEstilosAyuda();
        const ios = esIOS();
        const pasos = ios
            ? "Toca <b>Compartir</b> (el cuadro con la flecha ↑) y elige <b>Agregar a inicio</b>."
            : "Toca el botón verde <b>📲 Instalar app</b> (o el menú <b>⋮</b> → <b>Instalar app</b>).";

        const modal = document.createElement("div");
        modal.id = "ayudaModal";
        modal.innerHTML =
            '<div class="ay-card" role="dialog" aria-modal="true" aria-label="Cómo usar la app">' +
                '<h2>📱 ¿Cómo usar la app?</h2>' +
                '<p class="ay-intro">Guía rápida para los conductores.</p>' +

                '<h3>¿Para qué sirve?</h3>' +
                '<p>Consultas en vivo los vehículos en el <b>patio azul</b> del aeropuerto y recibes un <b>aviso</b> cada vez que se hace un despacho por un itinerario de <b>AEROPUERTO</b>.</p>' +

                '<h3>Las pestañas</h3>' +
                '<ul>' +
                    '<li><b>Mapa:</b> dónde están los buses.</li>' +
                    '<li><b>Listas:</b> vehículos en patio, por hora de llegada.</li>' +
                    '<li><b>Alertas:</b> historial de los despachos avisados.</li>' +
                    '<li><b>Realizados:</b> despachos con su estado (activo/cancelado).</li>' +
                '</ul>' +

                '<h3>📲 Instala la app</h3>' +
                '<p>Para recibir los avisos, instálala en tu celular: ' + pasos + ' Luego ábrela desde el <b>ícono</b>.</p>' +

                '<h3>🔔 Activa las notificaciones</h3>' +
                '<p>Cuando la app te lo pida, toca <b>Activar notificaciones</b> y dale <b>Permitir</b>.</p>' +
                '<div class="ay-ok">Consejo: mantén la app <b>abierta</b> mientras trabajas para escuchar el <b>sonido</b> del aviso.</div>' +

                '<h3>⚠️ Revisar GPS</h3>' +
                '<p>Si un bus aparece en <b>rojo</b> con <b>“REVISAR GPS”</b>, significa que lleva <b>más de 3 horas</b> en el patio. Hay que revisar su GPS.</p>' +

                (ios
                    ? '<div class="ay-note">En iPhone, las notificaciones solo funcionan con la app <b>instalada</b> (Agregar a inicio) y iOS 16.4 o más reciente.</div>'
                    : '') +

                '<button type="button" class="ay-close">Entendido</button>' +
            '</div>';
        document.body.appendChild(modal);

        function cerrar() { modal.remove(); }
        modal.querySelector(".ay-close").addEventListener("click", cerrar);
        modal.addEventListener("click", function (e) { if (e.target === modal) cerrar(); });
    }

    // ===== Pantalla obligatoria para activar notificaciones (conductores) =====
    function inyectarEstilosNotifGate() {
        if (document.getElementById("notifGateStyles")) return;
        const st = document.createElement("style");
        st.id = "notifGateStyles";
        st.textContent =
            "#notifGate{position:fixed;inset:0;z-index:100001;background:linear-gradient(160deg,#4f46e5,#3730a3);display:flex;align-items:center;justify-content:center;padding:24px;}" +
            "#notifGate .ng-card{background:#fff;border-radius:22px;max-width:380px;width:100%;padding:32px 26px;text-align:center;box-shadow:0 24px 70px rgba(0,0,0,.35);}" +
            "#notifGate .ng-bell{width:84px;height:84px;margin:0 auto 18px;border-radius:50%;background:#eef2ff;display:flex;align-items:center;justify-content:center;animation:ng-ring 1.6s ease-in-out infinite;}" +
            "#notifGate h2{margin:0 0 10px;font-size:22px;color:#1e293b;font-weight:800;}" +
            "#notifGate p{margin:0 0 22px;font-size:15px;color:#475569;line-height:1.5;}" +
            "#notifGate button.ng-main{background:#4f46e5;color:#fff;border:0;border-radius:12px;padding:16px 22px;font-size:16px;font-weight:800;cursor:pointer;width:100%;box-shadow:0 8px 24px rgba(79,70,229,.4);}" +
            "#notifGate .ng-help{margin-top:16px;font-size:13px;color:#334155;text-align:left;background:#f1f5f9;border-radius:12px;padding:14px;line-height:1.6;display:none;}" +
            "#notifGate .ng-skip{margin-top:16px;background:none;border:0;color:#94a3b8;font-size:13px;text-decoration:underline;cursor:pointer;}" +
            "#notifGate .ng-estado{margin-top:12px;font-size:11px;color:#cbd5e1;}" +
            "@keyframes ng-ring{0%,100%{transform:rotate(0);}20%{transform:rotate(14deg);}40%{transform:rotate(-12deg);}60%{transform:rotate(8deg);}80%{transform:rotate(-5deg);}}";
        document.head.appendChild(st);
    }

    function cerrarNotifGate() {
        const g = document.getElementById("notifGate");
        if (g) g.remove();
    }

    // ===== Web Push: suscribir el dispositivo para recibir avisos con la app cerrada =====
    function urlBase64ToUint8Array(base64String) {
        const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
        const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
        const raw = atob(base64);
        const arr = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
        return arr;
    }

    // Aviso flotante breve (confirma o explica el registro de notificaciones).
    function avisoPush(texto, ok) {
        try {
            let t = document.getElementById("avisoPush");
            if (!t) {
                t = document.createElement("div");
                t.id = "avisoPush";
                t.style.cssText = "position:fixed;left:50%;bottom:18px;transform:translateX(-50%);" +
                    "max-width:90%;z-index:99999;padding:12px 16px;border-radius:12px;font-size:14px;" +
                    "font-weight:600;color:#fff;box-shadow:0 6px 24px rgba(0,0,0,.25);text-align:center;";
                document.body.appendChild(t);
            }
            t.style.background = ok ? "#16a34a" : "#dc2626";
            t.textContent = texto;
            t.style.display = "block";
            clearTimeout(t._timer);
            t._timer = setTimeout(function () { t.style.display = "none"; }, ok ? 4000 : 9000);
        } catch (_) {}
    }

    async function registrarPush() {
        try {
            if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
                avisoPush("Este navegador no soporta notificaciones push.", false); return;
            }
            if (!cfg.VAPID_PUBLIC_KEY) return;
            if (!("Notification" in window) || Notification.permission !== "granted") return;

            const reg = await navigator.serviceWorker.ready;
            let sub = await reg.pushManager.getSubscription();
            if (!sub) {
                sub = await reg.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: urlBase64ToUint8Array(cfg.VAPID_PUBLIC_KEY),
                });
            }
            const json = sub.toJSON();
            if (!json || !json.endpoint || !json.keys) {
                avisoPush("No se pudo crear la suscripción push.", false); return;
            }
            // Guardar/actualizar la suscripción vía función segura (la tabla
            // está cerrada a anon; la función hace el upsert por dentro).
            const { error } = await client.rpc("registrar_push", {
                p_endpoint: json.endpoint,
                p_p256dh: json.keys.p256dh,
                p_auth: json.keys.auth,
                p_user_agent: navigator.userAgent,
            });
            if (error) throw error;
            console.log("[PUSH] Suscripción registrada");
            avisoPush("✓ Notificaciones activadas en este celular", true);
        } catch (err) {
            console.warn("[PUSH] No se pudo suscribir:", err);
            avisoPush("Error registrando notificaciones: " + (err && err.message ? err.message : err), false);
        }
    }

    // ¿El dispositivo es iPhone/iPad? (instalación y notificaciones son distintas)
    function esIOS() {
        const ua = navigator.userAgent || "";
        const iOSClasico = /iPhone|iPad|iPod/i.test(ua);
        // iPadOS 13+ se hace pasar por Mac; lo detectamos por el touch
        const iPadModerno = /Macintosh/i.test(ua) && navigator.maxTouchPoints > 1;
        return iOSClasico || iPadModerno;
    }

    // Pide el permiso de notificaciones (tras un gesto) y cierra el gate si se concede.
    function solicitarPermisoNotif(onResultado) {
        desbloquearAudio();
        if (!("Notification" in window)) { onResultado("no-soportado"); return; }
        if (Notification.permission === "granted") { onResultado("granted"); return; }
        if (Notification.permission === "denied") { onResultado("denied"); return; }
        Promise.resolve(Notification.requestPermission())
            .then(function (perm) { onResultado(perm); })
            .catch(function () { onResultado("denied"); });
    }

    // Pantalla de bienvenida: guía a instalar la PWA y a activar notificaciones.
    // Con la app abierta, el aviso (banner + sonido) funciona sin permisos; las
    // notificaciones del sistema son un extra que mejora si la PWA está instalada.
    function mostrarNotifGate() {
        const instalada = appInstaladaPWA();
        const ios = esIOS();
        const soportaNotif = "Notification" in window;

        // No molestar si ya está instalada y con permiso (o instalada sin soporte
        // de notificaciones, como iPhone con iOS antiguo: no hay más que pedir).
        if (instalada && (!soportaNotif || Notification.permission === "granted")) return;
        if (document.getElementById("notifGate")) return;

        inyectarEstilosNotifGate();
        const gate = document.createElement("div");
        gate.id = "notifGate";

        const pasosInstalar = ios
            ? "<b>En iPhone (Safari):</b><br>" +
              "1. Toca el botón <b>Compartir</b> (el cuadro con la flecha ↑, abajo).<br>" +
              "2. Desliza y elige <b>Agregar a inicio</b>.<br>" +
              "3. Abre la app desde el <b>ícono</b> que aparece en tu pantalla."
            : "<b>En Android (Chrome):</b><br>" +
              "1. Toca el menú <b>⋮</b> (arriba a la derecha) o el botón verde <b>Instalar app</b>.<br>" +
              "2. Elige <b>Instalar app</b> o <b>Agregar a pantalla de inicio</b>.<br>" +
              "3. Abre la app desde el <b>ícono</b> que aparece en tu celular.";

        const textoBoton = instalada
            ? "🔔 Activar notificaciones"
            : (ios ? "Ya la agregué · Continuar" : "Ya la instalé · Continuar");

        gate.innerHTML =
            '<div class="ng-card">' +
                '<div class="ng-bell">' +
                    '<svg width="42" height="42" viewBox="0 0 24 24" fill="none"><path d="M12 2a6 6 0 0 0-6 6c0 4-2 5-2 7h16c0-2-2-3-2-7a6 6 0 0 0-6-6zm0 20a3 3 0 0 0 3-3H9a3 3 0 0 0 3 3z" fill="#4f46e5"/></svg>' +
                '</div>' +
                '<h2>' + (instalada ? "Activa las notificaciones" : "Instala la app") + '</h2>' +
                '<p>' + (instalada
                    ? "Para enterarte al instante de cada <b>despacho</b>, activa los avisos."
                    : "Para recibir los avisos de despacho, primero <b>instala</b> esta app en tu celular.") + '</p>' +
                (instalada
                    ? '<button type="button" class="ng-main">' + textoBoton + '</button><div class="ng-help"></div>'
                    : '<div class="ng-help" style="display:block">' + pasosInstalar + '</div>' +
                      '<button type="button" class="ng-main">' + textoBoton + '</button>') +
                '<button type="button" class="ng-skip">Continuar (la app sonará igual estando abierta)</button>' +
                '<div class="ng-estado"></div>' +
            '</div>';
        document.body.appendChild(gate);

        const btn = gate.querySelector(".ng-main");
        const help = gate.querySelector(".ng-help");
        const estado = gate.querySelector(".ng-estado");

        function refrescarEstado() {
            const permiso = soportaNotif ? Notification.permission : "no disponible";
            estado.textContent = "Estado: " + (instalada ? "instalada · " : "no instalada · ") + "permiso " + permiso;
        }

        function mostrarAyudaBloqueado() {
            help.style.display = "block";
            help.innerHTML = "Las notificaciones están <b>bloqueadas</b>. Para activarlas:<br>" +
                "1. Abre los <b>ajustes del sitio</b> (candado 🔒 o ajustes del navegador).<br>" +
                "2. Entra en <b>Notificaciones</b> → <b>Permitir</b>.<br>" +
                "3. Vuelve a la app (se cierra sola).";
        }

        btn.addEventListener("click", function () {
            // Si no está instalada, este botón solo continúa (la instalación es por
            // el menú del navegador / Compartir, no por este botón).
            if (!instalada) {
                if (soportaNotif) solicitarPermisoNotif(function (perm) {
                    if (perm === "granted") registrarPush();
                    cerrarNotifGate();
                });
                else cerrarNotifGate();
                return;
            }
            // Instalada: pedir permiso de notificaciones.
            solicitarPermisoNotif(function (perm) {
                refrescarEstado();
                if (perm === "granted") { registrarPush(); cerrarNotifGate(); }
                else if (perm === "no-soportado") cerrarNotifGate();
                else if (perm === "denied") mostrarAyudaBloqueado();
            });
        });

        gate.querySelector(".ng-skip").addEventListener("click", cerrarNotifGate);

        // Si activa el permiso en Ajustes y vuelve, cerramos la pantalla sola.
        document.addEventListener("visibilitychange", function () {
            if (document.visibilityState === "visible" &&
                "Notification" in window && Notification.permission === "granted") {
                registrarPush();
                cerrarNotifGate();
            }
        });

        if (soportaNotif && Notification.permission === "denied") mostrarAyudaBloqueado();
        refrescarEstado();
    }

    // ===== Botón de instalación de la PWA dentro de la app =====
    // Chrome no siempre muestra "Instalar app" en su menú; capturamos el evento
    // beforeinstallprompt y ofrecemos un botón claro para instalar.
    let deferredInstallPrompt = null;

    function configurarInstalacion() {
        window.addEventListener("beforeinstallprompt", function (e) {
            e.preventDefault();
            deferredInstallPrompt = e;
            mostrarBotonInstalar();
        });
        window.addEventListener("appinstalled", function () {
            deferredInstallPrompt = null;
            const b = document.getElementById("btnInstalar");
            if (b) b.remove();
        });
    }

    function mostrarBotonInstalar() {
        if (!deferredInstallPrompt) return;
        if (document.getElementById("btnInstalar")) return;
        if (appInstaladaPWA()) return;
        const b = document.createElement("button");
        b.id = "btnInstalar";
        b.type = "button";
        b.textContent = "📲 Instalar app";
        b.style.cssText = "position:fixed;left:16px;bottom:16px;z-index:99998;background:#16a34a;color:#fff;border:0;border-radius:30px;padding:12px 18px;font-size:14px;font-weight:800;box-shadow:0 6px 20px rgba(22,163,74,.45);cursor:pointer;";
        b.addEventListener("click", async function () {
            if (!deferredInstallPrompt) return;
            try {
                deferredInstallPrompt.prompt();
                await deferredInstallPrompt.userChoice;
            } catch (_) { /* noop */ }
            deferredInstallPrompt = null;
            b.remove();
        });
        document.body.appendChild(b);
    }

    // Muestra una notificación del sistema operativo (PWA). Funciona con la app
    // abierta o minimizada; con la app totalmente cerrada haría falta Web Push.
    function notificacionSistema(titulo, cuerpo) {
        try {
            if (!("Notification" in window) || Notification.permission !== "granted") return;
            const opts = {
                body: cuerpo,
                icon: "icons/icon-192.png",
                badge: "icons/icon-192.png",
                vibrate: [200, 100, 200],
                tag: "despacho-jmc",
                renotify: true,
            };
            if (navigator.serviceWorker && navigator.serviceWorker.ready) {
                navigator.serviceWorker.ready
                    .then(function (reg) { reg.showNotification(titulo, opts); })
                    .catch(function () { try { new Notification(titulo, opts); } catch (_) {} });
            } else {
                new Notification(titulo, opts);
            }
        } catch (_) { /* noop */ }
    }


    function notificarDespacho(reg) {
        inyectarEstilosAlerta();
        reproducirAlarma();
        try { if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 300]); } catch (_) {}

        // Notificación del sistema (estilo PWA), además del banner dentro de la app.
        const busTxt = String(reg.interno || reg.vehicle_id || "—");
        const itinTxt = reg.itinerario || "Sin itinerario";
        notificacionSistema(
            "¡Nuevo despacho! Bus " + busTxt,
            "Será despachado por: " + itinTxt
        );

        const previa = document.getElementById("despachoAlert");
        if (previa) previa.remove();

        const bus = escapeHtml(reg.interno || reg.vehicle_id || "—");
        const itin = escapeHtml(reg.itinerario || "Sin itinerario");
        const hora = escapeHtml(formatHora(reg.created_at));

        const back = document.createElement("div");
        back.id = "despachoAlert";
        back.className = "despacho-alert-backdrop";
        back.innerHTML =
            '<div class="despacho-alert" role="alertdialog" aria-live="assertive">' +
                '<div class="da-icon">' +
                    '<svg width="32" height="32" viewBox="0 0 24 24" fill="none">' +
                        '<path d="M19 7h-3V5.5C16 4.12 14.88 3 13.5 3h-3C9.12 3 8 4.12 8 5.5V7H5c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V9c0-1.1-.9-2-2-2z" fill="#4f46e5"/>' +
                    '</svg>' +
                '</div>' +
                '<h2>¡Nuevo despacho!</h2>' +
                '<div class="da-bus">Bus ' + bus + '</div>' +
                '<div class="da-itin">Será despachado por:<br><b>' + itin + '</b></div>' +
                '<div class="da-hora">' + hora + '</div>' +
                '<button type="button">Entendido</button>' +
            '</div>';
        document.body.appendChild(back);

        function cerrar() { back.remove(); }
        back.querySelector("button").addEventListener("click", cerrar);
        back.addEventListener("click", function (e) { if (e.target === back) cerrar(); });
        setTimeout(cerrar, 12000); // auto-cierre
    }

    function realizadoMatchesSearch(r, q) {
        if (!q) return true;
        const campos = [
            r.interno, r.placa, r.itinerario, r.itinerario_id,
            r.estado, r.reg_id, r.vehicle_id, r.driver_id,
            r.observaciones, r.created_by,
        ];
        for (let i = 0; i < campos.length; i++) {
            const v = campos[i];
            if (v != null && String(v).toLowerCase().includes(q)) return true;
        }
        return false;
    }

    // Historial de alertas: muestra los despachos AEROPUERTO recientes en
    // formato de tarjeta, igual que las alertas que suenan en vivo.
    function renderAlertas() {
        const box = document.getElementById("alertasBox");
        const subtitle = document.getElementById("alertasSubtitle");
        const badge = document.getElementById("tabAlertasBadge");
        if (!box) return;

        const alertas = realizados
            .filter(esDespachoAeropuerto)
            .slice()
            .sort(function (a, b) {
                return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
            })
            .slice(0, 50); // últimas 50

        if (badge) badge.textContent = String(alertas.length);
        if (subtitle) subtitle.textContent = alertas.length
            ? "Últimas " + alertas.length + " alertas de despacho"
            : "Aún no hay alertas";

        if (!alertas.length) {
            box.innerHTML = '<div class="loading">Aún no hay alertas de despacho</div>';
            return;
        }

        box.innerHTML = alertas.map(function (r) {
            const bus = escapeHtml(r.interno || r.vehicle_id || "—");
            const itin = escapeHtml(r.itinerario || "Sin itinerario");
            const hora = escapeHtml(formatHora(r.created_at));
            const hace = escapeHtml(humanizeAge(r.created_at));
            const cancelado = r.estado !== "ACTIVO";
            return '<div class="alert-card' + (cancelado ? ' alert-card-cancel' : '') + '">' +
                    '<div class="alert-card-icon">🔔</div>' +
                    '<div class="alert-card-body">' +
                        '<div class="alert-card-bus">Bus ' + bus +
                            (cancelado ? ' <span class="alert-card-tag">Cancelado</span>' : '') + '</div>' +
                        '<div class="alert-card-itin">Despachado por: <b>' + itin + '</b></div>' +
                        '<div class="alert-card-time">' + hora + ' · ' + hace + '</div>' +
                    '</div>' +
                '</div>';
        }).join("");
    }

    // Chips de itinerario para la pestaña Realizados (modo consulta).
    function renderRealizadosChips(base) {
        const chipsBox = document.getElementById("realizadosChips");
        if (!chipsBox) return;

        // Conteo por itinerario (respetando el filtro "Solo activos")
        const fuente = realizadosFiltroActivos
            ? base.filter(function (r) { return r.estado === "ACTIVO"; })
            : base;
        const grupos = {};
        fuente.forEach(function (r) {
            const k = r.itinerario || "Sin itinerario";
            grupos[k] = (grupos[k] || 0) + 1;
        });
        const itins = Object.keys(grupos).sort();

        // Si el itinerario seleccionado ya no existe, volver a "Todos"
        if (realizadosItinSel && !itins.includes(realizadosItinSel)) realizadosItinSel = null;

        const total = fuente.length;
        const chipsHtml = [
            '<button type="button" class="chip ' + (realizadosItinSel === null ? "active" : "") + '" data-itin="">' +
                'Todos<span class="chip-count">' + total + '</span></button>',
        ].concat(itins.map(function (itin) {
            return '<button type="button" class="chip ' + (realizadosItinSel === itin ? "active" : "") + '" data-itin="' + escapeHtml(itin) + '">' +
                escapeHtml(itin) + '<span class="chip-count">' + grupos[itin] + '</span></button>';
        })).join("");
        chipsBox.innerHTML = chipsHtml;

        chipsBox.querySelectorAll(".chip").forEach(function (btn) {
            btn.addEventListener("click", function () {
                const val = btn.getAttribute("data-itin");
                realizadosItinSel = val ? val : null;
                realizadosPage = 1;
                renderRealizados();
            });
        });
    }

    function renderRealizados() {
        const box = document.getElementById("realizadosBox");
        const subtitle = document.getElementById("realizadosSubtitle");
        const badge = document.getElementById("tabRealizadosBadge");
        const pager = document.getElementById("realizadosPager");
        const pagerInfo = document.getElementById("pagerInfo");
        const pagerPrev = document.getElementById("pagerPrev");
        const pagerNext = document.getElementById("pagerNext");
        if (!box) return;

        // En modo consulta solo mostramos despachos del grupo AEROPUERTO.
        const base = MODO_CONSULTA
            ? realizados.filter(esDespachoAeropuerto)
            : realizados;

        // Chips de filtro por itinerario (separar los despachos por ruta).
        if (MODO_CONSULTA) renderRealizadosChips(base);

        const q = (realizadosSearch || "").toLowerCase().trim();
        let visibles = realizadosFiltroActivos
            ? base.filter(function (r) { return r.estado === "ACTIVO"; })
            : base.slice();
        if (MODO_CONSULTA && realizadosItinSel) {
            visibles = visibles.filter(function (r) {
                return (r.itinerario || "Sin itinerario") === realizadosItinSel;
            });
        }
        if (q) visibles = visibles.filter(function (r) { return realizadoMatchesSearch(r, q); });

        if (badge) badge.textContent = String(visibles.length);
        if (subtitle) {
            const activos = base.filter(function (r) { return r.estado === "ACTIVO"; }).length;
            const cancelados = base.length - activos;
            subtitle.textContent = `${activos} activos · ${cancelados} cancelados · ${base.length} totales`;
        }

        if (!visibles.length) {
            box.innerHTML = q
                ? '<div class="loading">No hay resultados para tu búsqueda</div>'
                : '<div class="loading">No hay despachos realizados todavía</div>';
            if (pager) pager.hidden = true;
            return;
        }

        // Paginación
        const totalPaginas = Math.max(1, Math.ceil(visibles.length / REALIZADOS_PAGE_SIZE));
        if (realizadosPage > totalPaginas) realizadosPage = totalPaginas;
        if (realizadosPage < 1) realizadosPage = 1;
        const inicio = (realizadosPage - 1) * REALIZADOS_PAGE_SIZE;
        const paginaItems = visibles.slice(inicio, inicio + REALIZADOS_PAGE_SIZE);

        if (pager) {
            pager.hidden = totalPaginas <= 1;
            if (pagerInfo) {
                pagerInfo.textContent =
                    `Página ${realizadosPage} de ${totalPaginas} · ${visibles.length} registros`;
            }
            if (pagerPrev) pagerPrev.disabled = realizadosPage <= 1;
            if (pagerNext) pagerNext.disabled = realizadosPage >= totalPaginas;
        }

        const ahora = Date.now();
        const filas = paginaItems.map(function (r) {
            const hora = formatHora(r.created_at);
            const hace = humanizeAge(r.created_at);
            const isCancelado = r.estado !== "ACTIVO";
            const estadoCls = isCancelado ? "cancelado-est" : "activo";
            const estadoTxt = isCancelado ? "CANCELADO" : "ACTIVO";
            const creadoMs = new Date(r.created_at).getTime();
            const expirado = Number.isFinite(creadoMs) && (ahora - creadoMs) > CANCEL_WINDOW_MS;

            let accionHtml;
            if (isCancelado) {
                accionHtml = '<span class="muted" style="font-size:11px;">—</span>';
            } else if (expirado) {
                accionHtml = '<span class="muted" title="No se puede cancelar después de 1 hora" style="font-size:11px;">Expirado</span>';
            } else {
                accionHtml = `<button type="button" class="btn-cancelar" data-action="cancelar"
                    data-id="${escapeHtml(r.id)}"
                    data-reg-id="${escapeHtml(r.reg_id)}"
                    data-mid="${escapeHtml(r.vehicle_id || "")}">Cancelar</button>`;
            }

            // En modo consulta: solo lectura, sin pasajeros, sin editar ni cancelar.
            if (MODO_CONSULTA) {
                return `
                    <tr data-id="${escapeHtml(r.id)}" data-reg-id="${escapeHtml(r.reg_id)}" data-mid="${escapeHtml(r.vehicle_id || "")}">
                        <td class="hora">${escapeHtml(hora)}</td>
                        <td class="hace">${escapeHtml(hace)}</td>
                        <td class="interno">${escapeHtml(r.interno || "")}</td>
                        <td>${escapeHtml(r.itinerario || "")}</td>
                        <td>${escapeHtml(r.observaciones || "—")}</td>
                        <td><span class="estado-pill ${estadoCls}">${estadoTxt}</span></td>
                    </tr>
                `;
            }

            return `
                <tr data-id="${escapeHtml(r.id)}" data-reg-id="${escapeHtml(r.reg_id)}" data-mid="${escapeHtml(r.vehicle_id || "")}">
                    <td class="hora">${escapeHtml(hora)}</td>
                    <td class="hace">${escapeHtml(hace)}</td>
                    <td class="interno">
                        ${escapeHtml(r.interno || "")}
                    </td>
                    <td>${escapeHtml(r.itinerario || "")}</td>
                    <td>
                        <input type="number" min="0" max="999" class="pasajeros-input"
                            value="${escapeHtml(r.pasajeros ?? 0)}"
                            ${isCancelado ? "disabled" : ""}
                            data-id="${escapeHtml(r.id)}">
                    </td>
                    <td>
                        <input type="text" class="observaciones-input"
                            value="${escapeHtml(r.observaciones || "")}"
                            placeholder="Sin observaciones"
                            maxlength="500"
                            ${isCancelado ? "disabled" : ""}
                            data-id="${escapeHtml(r.id)}">
                    </td>
                    <td><span class="estado-pill ${estadoCls}">${estadoTxt}</span></td>
                    <td>${accionHtml}</td>
                </tr>
            `;
        }).join("");

        box.innerHTML = MODO_CONSULTA ? `
            <table class="arrivals realizados-consulta">
                <thead>
                    <tr>
                        <th>Hora</th>
                        <th>Hace</th>
                        <th>Bus</th>
                        <th>Itinerario</th>
                        <th>Observaciones</th>
                        <th>Estado</th>
                    </tr>
                </thead>
                <tbody>${filas}</tbody>
            </table>
        ` : `
            <table class="arrivals">
                <thead>
                    <tr>
                        <th>Hora</th>
                        <th>Hace</th>
                        <th>Bus</th>
                        <th>Itinerario</th>
                        <th>Pasajeros</th>
                        <th>Observaciones</th>
                        <th>Estado</th>
                        <th>Acción</th>
                    </tr>
                </thead>
                <tbody>${filas}</tbody>
            </table>
        `;

        // Listeners para edición de pasajeros (auto-save al cambiar)
        box.querySelectorAll(".pasajeros-input").forEach(function (input) {
            input.addEventListener("change", async function () {
                const id = input.dataset.id;
                const nuevo = parseInt(input.value, 10);
                if (!Number.isFinite(nuevo) || nuevo < 0) {
                    input.value = "0";
                    return;
                }
                input.classList.add("saving");
                try {
                    const { error } = await client
                        .from(cfg.TABLA_REALIZADOS)
                        .update({ pasajeros: nuevo })
                        .eq("id", id);
                    if (error) throw error;
                    input.classList.remove("saving");
                    input.classList.add("saved");
                    setTimeout(function () { input.classList.remove("saved"); }, 1500);
                    const r = realizados.find(function (x) { return x.id === id; });
                    if (r) r.pasajeros = nuevo;
                } catch (err) {
                    input.classList.remove("saving");
                    showToast("err", "Error guardando pasajeros: " + (err.message || err));
                }
            });
        });

        // Listeners para edición de observaciones (auto-save con debounce + en blur)
        box.querySelectorAll(".observaciones-input").forEach(function (input) {
            let t = null;
            async function guardar() {
                const id = input.dataset.id;
                const nuevo = (input.value || "").trim();
                const r = realizados.find(function (x) { return x.id === id; });
                if (r && (r.observaciones || "") === nuevo) return; // sin cambios reales
                input.classList.add("saving");
                try {
                    const { error } = await client
                        .from(cfg.TABLA_REALIZADOS)
                        .update({ observaciones: nuevo })
                        .eq("id", id);
                    if (error) throw error;
                    input.classList.remove("saving");
                    input.classList.add("saved");
                    setTimeout(function () { input.classList.remove("saved"); }, 1500);
                    if (r) r.observaciones = nuevo;
                } catch (err) {
                    input.classList.remove("saving");
                    showToast("err", "Error guardando observación: " + (err.message || err));
                }
            }
            // Auto-save 700ms después de dejar de escribir
            input.addEventListener("input", function () {
                clearTimeout(t);
                t = setTimeout(guardar, 700);
            });
            // Y al perder el foco, garantizado
            input.addEventListener("blur", function () {
                clearTimeout(t);
                guardar();
            });
        });

        // Listeners para cancelar
        box.querySelectorAll('[data-action="cancelar"]').forEach(function (btn) {
            btn.addEventListener("click", async function () {
                const id = btn.dataset.id;
                const regId = btn.dataset.regId;
                const mId = btn.dataset.mid;
                const reg = realizados.find(function (x) { return x.id === id; });
                // Doble verificación: bloquea si pasó la ventana de 1h
                if (reg?.created_at) {
                    const ageMs = Date.now() - new Date(reg.created_at).getTime();
                    if (Number.isFinite(ageMs) && ageMs > CANCEL_WINDOW_MS) {
                        showToast("err", "No se puede cancelar: pasó más de 1 hora desde el despacho");
                        renderRealizados();
                        return;
                    }
                }
                const detalleHtml = `
                    <div><strong>Bus:</strong> ${escapeHtml(reg?.interno || mId)}</div>
                    <div><strong>Itinerario:</strong> ${escapeHtml(reg?.itinerario || "—")}</div>
                    <div><strong>Despachado:</strong> ${escapeHtml(formatHora(reg?.created_at))} · ${escapeHtml(humanizeAge(reg?.created_at))}</div>
                `;
                const ok = await mostrarConfirmacion({
                    titulo: "Cancelar despacho",
                    mensaje: "Esta acción anula el despacho en Sonar y no se puede deshacer.",
                    detalle: detalleHtml,
                    textoConfirmar: "Sí, cancelar despacho",
                    textoCancelar: "Volver",
                    tipo: "danger",
                });
                if (!ok) return;

                btn.disabled = true;
                btn.textContent = "Cancelando...";
                try {
                    const resp = await fetch(cfg.SONAR_CANCEL_URL, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            apikey: cfg.SUPABASE_ANON_KEY,
                            Authorization: "Bearer " + cfg.SUPABASE_ANON_KEY,
                        },
                        body: JSON.stringify({
                            mId,
                            regId,
                            comments: "Cancelado desde web",
                            dispatchId: id,
                            canceledBy: currentUser?.email || "unknown",
                            vehicle: { interno: reg?.interno, placa: reg?.placa },
                            dispatch: { itinerario: reg?.itinerario, itinerario_id: reg?.itinerario_id },
                        }),
                    });
                    const data = await resp.json().catch(function () { return {}; });
                    if (!resp.ok || data.success === false) {
                        throw new Error(data.message || ("HTTP " + resp.status));
                    }
                    // Marcar como cancelado en la tabla
                    await client.from(cfg.TABLA_REALIZADOS).update({
                        estado: "CANCELADO",
                        cancelled_at: new Date().toISOString(),
                        cancel_response: data?.data || null,
                    }).eq("id", id);
                    showToast("ok", "Despacho cancelado");
                } catch (err) {
                    showToast("err", "Error: " + (err.message || err));
                    btn.disabled = false;
                    btn.textContent = "Cancelar";
                }
            });
        });
    }

    function initRealizadosControles() {
        const chk = document.getElementById("filterRealizadosActivos");
        if (chk) {
            chk.addEventListener("change", function () {
                realizadosFiltroActivos = chk.checked;
                realizadosPage = 1;
                renderRealizados();
            });
        }
        const search = document.getElementById("searchRealizados");
        if (search) {
            let t = null;
            search.addEventListener("input", function () {
                clearTimeout(t);
                t = setTimeout(function () {
                    realizadosSearch = search.value || "";
                    realizadosPage = 1;
                    renderRealizados();
                }, 200);
            });
        }
        const pPrev = document.getElementById("pagerPrev");
        const pNext = document.getElementById("pagerNext");
        if (pPrev) {
            pPrev.addEventListener("click", function () {
                if (realizadosPage > 1) {
                    realizadosPage--;
                    renderRealizados();
                }
            });
        }
        if (pNext) {
            pNext.addEventListener("click", function () {
                realizadosPage++;
                renderRealizados();
            });
        }
    }

    // ============== Carga inicial + Realtime ==============
    async function cargarInicial() {
        if (!navigator.onLine) {
            setConnection("offline");
            return;
        }
        try {
            const { data, error } = await client
                .from(cfg.TABLA)
                .select("*")
                .order("itinerario", { ascending: true })
                .order("posicion", { ascending: true });
            if (error) throw error;
            rows = data || [];
            updateStats();
            renderChipsAndTable();
            renderMap();
            setLastUpdate();
            reconnectDelay = 2000;
        } catch (err) {
            console.error("Error cargando datos:", err);
            const tablaBox = document.getElementById("tablaBox");
            if (!rows.length) {
                tablaBox.innerHTML =
                    `<div class="loading">Sin datos. Reintentando...</div>`;
            }
            setConnection(navigator.onLine ? "err" : "offline");
            programarReintento();
        }
    }

    function suscribirRealtime() {
        if (realtimeChannel) {
            try { client.removeChannel(realtimeChannel); } catch (_) { /* noop */ }
            realtimeChannel = null;
        }
        realtimeChannel = client
            .channel("llegadas_104_changes")
            .on("postgres_changes", { event: "*", schema: "public", table: cfg.TABLA }, function () {
                cargarInicial();
            })
            .subscribe(function (status) {
                if (status === "SUBSCRIBED") {
                    setConnection("ok");
                    reconnectDelay = 2000;
                } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
                    setConnection(navigator.onLine ? "reconnecting" : "offline");
                    programarReintento();
                }
            });
    }

    function programarReintento() {
        if (reconnectTimer) return;
        if (!navigator.onLine) return;
        const wait = reconnectDelay;
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
        console.log(`Reintentando en ${wait}ms...`);
        reconnectTimer = setTimeout(function () {
            reconnectTimer = null;
            cargarInicial();
            suscribirRealtime();
        }, wait);
    }

    // ============== Detección online/offline ==============
    window.addEventListener("online", function () {
        console.log("Conexión recuperada");
        setConnection("reconnecting");
        reconnectDelay = 2000;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        cargarInicial();
        suscribirRealtime();
    });

    window.addEventListener("offline", function () {
        console.log("Sin internet");
        setConnection("offline");
    });

    document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "visible" && navigator.onLine) {
            cargarInicial();
            if (!realtimeChannel || realtimeChannel.state !== "joined") {
                suscribirRealtime();
            }
        }
    });

    // Refresca "hace X min" cada minuto sin volver a pedir datos.
    setInterval(function () {
        renderChipsAndTable();
        if (despachos.length) renderDespachos();
    }, 60000);

    // Auto-refresh de despachos cada 2 minutos si estás en la pestaña
    setInterval(function () {
        if (activeTab === "despachos" && navigator.onLine) cargarDespachos();
    }, 120000);

    function initDespachosControles() {
        const btn = document.getElementById("btnRefreshDespachos");
        if (btn) btn.addEventListener("click", cargarDespachos);
        const chk = document.getElementById("filterActivos");
        if (chk) {
            chk.addEventListener("change", function () {
                despachosFiltroActivos = chk.checked;
                renderDespachos();
            });
        }
    }

    // ============== Despacho manual ==============
    function parseCsv(text) {
        // Parser CSV mínimo: maneja comillas dobles y comas dentro de comillas.
        const rows = [];
        let i = 0, field = "", row = [], inQuotes = false;
        while (i < text.length) {
            const c = text[i];
            if (inQuotes) {
                if (c === '"') {
                    if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
                    inQuotes = false; i++; continue;
                }
                field += c; i++; continue;
            }
            if (c === '"') { inQuotes = true; i++; continue; }
            if (c === ",") { row.push(field); field = ""; i++; continue; }
            if (c === "\r") { i++; continue; }
            if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
            field += c; i++;
        }
        if (field.length || row.length) { row.push(field); rows.push(row); }
        if (!rows.length) return [];
        const headers = rows.shift().map(function (h) { return h.trim(); });
        return rows
            .filter(function (r) { return r.some(function (v) { return v && v.trim().length; }); })
            .map(function (r) {
                const obj = {};
                headers.forEach(function (h, idx) { obj[h] = (r[idx] || "").trim(); });
                return obj;
            });
    }

    async function cargarConductores() {
        if (conductoresLoading) return conductoresLoading;
        conductoresLoading = (async function () {
            try {
                const resp = await fetch(cfg.CONDUCTORES_CSV_URL, { cache: "no-store" });
                if (!resp.ok) throw new Error("HTTP " + resp.status);
                const text = await resp.text();
                const filas = parseCsv(text);
                conductores = filas
                    .filter(function (c) {
                        return c.dr_id && c.nombre &&
                            (c.status || "").toUpperCase() === "ENABLED";
                    })
                    .sort(function (a, b) { return a.nombre.localeCompare(b.nombre, "es"); });
            } catch (err) {
                console.warn("Error cargando conductores:", err);
                conductores = [];
            } finally {
                conductoresLoading = null;
            }
        })();
        return conductoresLoading;
    }

    async function cargarVehiculos() {
        if (vehiculosLoading) return vehiculosLoading;
        vehiculosLoading = (async function () {
            try {
                const { data, error } = await client
                    .from(cfg.TABLA_VEHICULOS)
                    .select('"ID","INTERNO","Placa"')
                    .order("INTERNO", { ascending: true });
                if (error) throw error;
                vehiculos = (data || [])
                    .filter(function (v) { return v && v.ID; })
                    .map(function (v) {
                        return { mid: v.ID, interno: v.INTERNO, placa: v.Placa };
                    });
            } catch (err) {
                console.warn("Error cargando vehículos:", err);
                vehiculos = [];
            } finally {
                vehiculosLoading = null;
            }
        })();
        return vehiculosLoading;
    }

    function normalizar(s) {
        return String(s == null ? "" : s)
            .normalize("NFD")
            .replace(/[̀-ͯ]/g, "")
            .toLowerCase()
            .trim();
    }

    function buscarVehiculoPorInterno(val) {
        const v = normalizar(val);
        if (!v) return null;
        return vehiculos.find(function (x) {
            return normalizar(x.interno) === v;
        }) || null;
    }

    function buscarConductorPorNombre(val) {
        const v = normalizar(val);
        if (!v) return null;
        return conductores.find(function (c) {
            return normalizar(c.nombre) === v;
        }) || null;
    }

    // ===== Combobox genérico (input + dropdown filtrable) =====
    function setupCombobox(opts) {
        // opts: { input, list, getItems, getValue, matches(item, q), renderItem(item), onSelect(item) }
        const input = opts.input;
        const list = opts.list;
        let activeIndex = -1;
        let resultados = [];

        function abrir() {
            const q = input.value;
            const items = opts.getItems();
            resultados = q.trim()
                ? items.filter(function (it) { return opts.matches(it, q); })
                : items.slice(0, 100);
            renderLista();
            list.hidden = false;
        }

        function cerrar() {
            list.hidden = true;
            activeIndex = -1;
        }

        function renderLista() {
            if (!resultados.length) {
                list.innerHTML = '<div class="combobox-empty">Sin resultados</div>';
                return;
            }
            list.innerHTML = resultados.slice(0, 50).map(function (it, idx) {
                const html = opts.renderItem(it);
                return `<div class="combobox-item${idx === activeIndex ? " active" : ""}" role="option" data-idx="${idx}">${html}</div>`;
            }).join("");
        }

        function seleccionar(idx) {
            const it = resultados[idx];
            if (!it) return;
            input.value = opts.getValue(it);
            cerrar();
            if (opts.onSelect) opts.onSelect(it);
        }

        input.addEventListener("focus", abrir);
        input.addEventListener("input", function () {
            activeIndex = -1;
            abrir();
            if (opts.onChange) opts.onChange();
        });
        input.addEventListener("keydown", function (ev) {
            if (list.hidden) {
                if (ev.key === "ArrowDown" || ev.key === "Enter") { abrir(); ev.preventDefault(); }
                return;
            }
            if (ev.key === "ArrowDown") {
                activeIndex = Math.min(resultados.length - 1, activeIndex + 1);
                renderLista();
                ev.preventDefault();
            } else if (ev.key === "ArrowUp") {
                activeIndex = Math.max(0, activeIndex - 1);
                renderLista();
                ev.preventDefault();
            } else if (ev.key === "Enter") {
                if (activeIndex >= 0) {
                    seleccionar(activeIndex);
                    ev.preventDefault();
                }
            } else if (ev.key === "Escape") {
                cerrar();
            }
        });
        // Click en un item del dropdown
        list.addEventListener("mousedown", function (ev) {
            const el = ev.target.closest(".combobox-item");
            if (!el) return;
            ev.preventDefault(); // evita perder el foco antes del click
            const idx = parseInt(el.dataset.idx, 10);
            if (Number.isFinite(idx)) seleccionar(idx);
        });
        // Cerrar al hacer clic fuera
        document.addEventListener("mousedown", function (ev) {
            if (!list.hidden && !input.parentElement.contains(ev.target)) cerrar();
        });

        return { abrir, cerrar };
    }

    function extraerBase(email) {
        if (!email) return "";
        const m = String(email).match(/BASE\s*\d+/i);
        return m ? m[0].toUpperCase().replace(/\s+/, " ") : "";
    }

    function actualizarCamposVehiculo() {
        const inputInterno = document.getElementById("manualInterno");
        const inputMid = document.getElementById("manualMid");
        const v = buscarVehiculoPorInterno(inputInterno.value);
        inputMid.value = v ? v.mid : "";
    }

    function actualizarCamposConductor() {
        const inputCond = document.getElementById("manualConductor");
        const inputDrvId = document.getElementById("manualDriverId");
        const inputBase = document.getElementById("manualBase");
        const c = buscarConductorPorNombre(inputCond.value);
        inputDrvId.value = c ? c.dr_id : "";
        inputBase.value = c ? extraerBase(c.email) : "";
    }

    function abrirManualModal() {
        const modal = document.getElementById("manualModal");
        const selItin = document.getElementById("manualItin");

        // Itinerarios permitidos para despacho manual
        const PERMITIDOS = ["3385", "4501", "4503", "4507"];
        const itins = (cfg.ITINERARIOS || []).filter(function (i) { return PERMITIDOS.includes(i.id); });
        selItin.innerHTML = '<option value="">Selecciona itinerario...</option>' +
            itins.map(function (i) {
                return `<option value="${escapeHtml(i.id)}">${escapeHtml(i.nombre)} (${escapeHtml(i.grupo)})</option>`;
            }).join("");

        document.getElementById("manualInterno").value = "";
        document.getElementById("manualMid").value = "";
        document.getElementById("manualBase").value = "";
        document.getElementById("manualConductor").value = "";
        document.getElementById("manualDriverId").value = "";
        document.getElementById("manualObs").value = "";
        document.getElementById("manualError").hidden = true;

        const aviso = [];
        if (!vehiculos.length) aviso.push("Sin vehículos cargados");
        if (!conductores.length) aviso.push("Sin conductores cargados");
        if (aviso.length) {
            const err = document.getElementById("manualError");
            err.textContent = aviso.join(" · ") + " — revisa la conexión / RLS";
            err.hidden = false;
        }

        modal.hidden = false;
        setTimeout(function () { document.getElementById("manualInterno").focus(); }, 50);
    }

    function cerrarManualModal() {
        document.getElementById("manualModal").hidden = true;
    }

    async function submitManual(ev) {
        ev.preventDefault();
        const submitBtn = document.getElementById("manualSubmit");
        const errorBox = document.getElementById("manualError");

        // Vehículo (resuelto por interno)
        const internoVal = document.getElementById("manualInterno").value.trim();
        const v = buscarVehiculoPorInterno(internoVal);
        const mId = v ? v.mid : "";
        const interno = v ? String(v.interno || "") : internoVal;
        const placa = v ? String(v.placa || "") : "";

        // Conductor (resuelto por nombre)
        const condVal = document.getElementById("manualConductor").value.trim();
        const c = buscarConductorPorNombre(condVal);
        const drvId = c ? c.dr_id : "";
        const driverNombre = c ? c.nombre : condVal;

        const itinerary = document.getElementById("manualItin").value;
        const observaciones = document.getElementById("manualObs").value.trim();

        if (!mId) { errorBox.textContent = "Selecciona un interno válido de la lista (MID requerido)."; errorBox.hidden = false; return; }
        if (!drvId) { errorBox.textContent = "Selecciona un conductor válido de la lista (Driver ID requerido)."; errorBox.hidden = false; return; }
        if (!itinerary) { errorBox.textContent = "Selecciona un itinerario."; errorBox.hidden = false; return; }

        const itinObj = (cfg.ITINERARIOS || []).find(function (i) { return i.id === itinerary; });

        const detalleHtml = `
            <div><strong>Bus:</strong> ${escapeHtml(interno || mId)}${placa ? ` <span class="placa-tag">${escapeHtml(placa)}</span>` : ""}</div>
            <div><strong>Conductor:</strong> ${escapeHtml(driverNombre)} (${escapeHtml(drvId)})</div>
            <div><strong>Itinerario:</strong> ${escapeHtml(itinObj?.nombre || itinerary)}</div>
            ${observaciones ? `<div><strong>Observación:</strong> ${escapeHtml(observaciones)}</div>` : ""}
        `;
        const ok = await mostrarConfirmacion({
            titulo: "Confirmar despacho manual",
            mensaje: "Se enviará la orden a Sonar y quedará registrada en Despachos realizados.",
            detalle: detalleHtml,
            textoConfirmar: "Sí, despachar",
            textoCancelar: "Revisar",
            tipo: "info",
        });
        if (!ok) return;

        errorBox.hidden = true;
        submitBtn.disabled = true;
        submitBtn.textContent = "Enviando...";

        try {
            const resp = await fetch(cfg.SONAR_DISPATCH_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    apikey: cfg.SUPABASE_ANON_KEY,
                    Authorization: "Bearer " + cfg.SUPABASE_ANON_KEY,
                },
                body: JSON.stringify({ mId, itinerary, drvId, observaciones }),
            });
            const data = await resp.json().catch(function () { return {}; });
            if (!resp.ok || data.success === false) {
                throw new Error(data.message || data.error || ("HTTP " + resp.status));
            }

            const regId = data?.data?.regId || "";
            if (regId) {
                try {
                    const { error } = await client.from(cfg.TABLA_REALIZADOS).insert({
                        reg_id: regId,
                        vehicle_id: mId,
                        interno: interno || mId,
                        placa: placa,
                        itinerario_id: itinerary,
                        itinerario: itinObj?.nombre || "",
                        driver_id: drvId,
                        observaciones: observaciones,
                        pasajeros: 0,
                        created_by: currentUser?.id || null,
                    });
                    if (error) console.warn("Insert despachos_realizados (manual) falló:", error);
                } catch (e) {
                    console.warn("No se pudo guardar el despacho manual local:", e);
                }
            }

            cerrarManualModal();
            showToast("ok", `Despacho manual asignado${regId ? " · regId: " + regId : ""}`);
        } catch (err) {
            errorBox.textContent = "Error: " + (err.message || String(err));
            errorBox.hidden = false;
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = "Enviar despacho";
        }
    }

    function initManualModal() {
        const modal = document.getElementById("manualModal");
        if (!modal) return;
        modal.querySelectorAll("[data-close]").forEach(function (btn) {
            btn.addEventListener("click", cerrarManualModal);
        });
        modal.addEventListener("click", function (ev) {
            if (ev.target === modal) cerrarManualModal();
        });
        document.addEventListener("keydown", function (ev) {
            if (ev.key === "Escape" && !modal.hidden) cerrarManualModal();
        });
        document.getElementById("manualForm").addEventListener("submit", submitManual);

        // Combobox de vehículos: filtra por interno o placa
        const inputInterno = document.getElementById("manualInterno");
        const listInterno = inputInterno.parentElement.querySelector(".combobox-list");
        setupCombobox({
            input: inputInterno,
            list: listInterno,
            getItems: function () { return vehiculos; },
            getValue: function (v) { return v.interno != null ? String(v.interno) : ""; },
            matches: function (v, q) {
                const n = normalizar(q);
                return normalizar(v.interno).includes(n) ||
                    normalizar(v.placa).includes(n) ||
                    normalizar(v.mid).includes(n);
            },
            renderItem: function (v) {
                return `<span class="combobox-item-title">${escapeHtml(v.interno || "")}</span>` +
                    `<span class="combobox-item-meta">${escapeHtml(v.placa || "")} · MID ${escapeHtml(v.mid)}</span>`;
            },
            onSelect: actualizarCamposVehiculo,
            onChange: actualizarCamposVehiculo,
        });

        // Combobox de conductores: filtra por nombre o cédula
        const inputCond = document.getElementById("manualConductor");
        const listCond = inputCond.parentElement.querySelector(".combobox-list");
        setupCombobox({
            input: inputCond,
            list: listCond,
            getItems: function () { return conductores; },
            getValue: function (c) { return c.nombre || ""; },
            matches: function (c, q) {
                const n = normalizar(q);
                return normalizar(c.nombre).includes(n) ||
                    normalizar(c.cedula).includes(n) ||
                    normalizar(c.dr_id).includes(n);
            },
            renderItem: function (c) {
                const base = extraerBase(c.email);
                const meta = [c.cedula ? "Cédula " + c.cedula : "", base, "ID " + c.dr_id].filter(Boolean).join(" · ");
                return `<span class="combobox-item-title">${escapeHtml(c.nombre)}</span>` +
                    `<span class="combobox-item-meta">${escapeHtml(meta)}</span>`;
            },
            onSelect: actualizarCamposConductor,
            onChange: actualizarCamposConductor,
        });

        const btn = document.getElementById("btnManualDispatch");
        if (btn) {
            btn.addEventListener("click", async function () {
                const tareas = [];
                if (!vehiculos.length) tareas.push(cargarVehiculos());
                if (!conductores.length) tareas.push(cargarConductores());
                if (tareas.length) await Promise.all(tareas);
                abrirManualModal();
            });
        }
    }

    // ============== AUTH ==============
    function initAuth() {
        // Modo consulta: sin inicio de sesión. Arrancamos directo con la clave
        // pública (anon). Requiere que las tablas tengan RLS con SELECT para anon.
        if (MODO_CONSULTA) {
            const loginScreen = document.getElementById("loginScreen");
            if (loginScreen) loginScreen.hidden = true;
            const btnLogout = document.getElementById("btnLogout");
            if (btnLogout) btnLogout.hidden = true;
            startApp();
            return;
        }

        const form = document.getElementById("loginForm");
        const errorBox = document.getElementById("loginError");
        const submitBtn = document.getElementById("loginSubmit");
        const btnLogout = document.getElementById("btnLogout");

        if (form) {
            form.addEventListener("submit", async function (ev) {
                ev.preventDefault();
                errorBox.hidden = true;
                submitBtn.disabled = true;
                submitBtn.textContent = "Entrando...";
                const email = document.getElementById("loginEmail").value.trim();
                const password = document.getElementById("loginPass").value;
                console.log("[LOGIN] Intentando con:", email);
                try {
                    const { data, error } = await client.auth.signInWithPassword({ email, password });
                    console.log("[LOGIN] Respuesta:", { user: data?.user?.email, error });
                    if (error) throw error;
                    if (!data?.user) throw new Error("Sin usuario en la respuesta");
                    // Forzar transición a la app sin esperar onAuthStateChange
                    currentUser = data.user;
                    actualizarUiAuth();
                    if (!appStarted) startApp();
                    console.log("[LOGIN] App iniciada");
                } catch (err) {
                    console.error("[LOGIN] Error:", err);
                    // Mostrar el mensaje real de Supabase para diagnosticar
                    const msg = err?.message || String(err);
                    errorBox.textContent = msg;
                    errorBox.hidden = false;
                } finally {
                    submitBtn.disabled = false;
                    submitBtn.textContent = "Entrar";
                }
            });
        }

        if (btnLogout) {
            btnLogout.addEventListener("click", async function () {
                const ok = await mostrarConfirmacion({
                    titulo: "Cerrar sesión",
                    mensaje: "Volverás a la pantalla de inicio de sesión. Tu trabajo en curso se guardó automáticamente.",
                    detalle: currentUser?.email
                        ? `<div><strong>Usuario:</strong> ${escapeHtml(currentUser.email)}</div>`
                        : "",
                    textoConfirmar: "Cerrar sesión",
                    textoCancelar: "Seguir trabajando",
                    tipo: "warn",
                });
                if (!ok) return;
                await client.auth.signOut();
            });
        }

        // Detectar cambios de sesión (login, logout, refresh)
        client.auth.onAuthStateChange(function (event, session) {
            console.log("[AUTH] Evento:", event, "user:", session?.user?.email);
            currentUser = session?.user || null;
            actualizarUiAuth();
            if (currentUser && !appStarted) startApp();
            if (!currentUser) detenerRealizadosRealtime();
        });

        // Verificar sesión actual al cargar
        client.auth.getSession().then(function (res) {
            currentUser = res.data?.session?.user || null;
            actualizarUiAuth();
            if (currentUser) startApp();
        });
    }

    function actualizarUiAuth() {
        const loginScreen = document.getElementById("loginScreen");
        const btnLogout = document.getElementById("btnLogout");
        const btnManual = document.getElementById("btnManualDispatch");
        if (currentUser) {
            loginScreen.hidden = true;
            btnLogout.hidden = false;
            btnLogout.title = `Cerrar sesión (${currentUser.email})`;
            if (btnManual) btnManual.hidden = false;
        } else {
            loginScreen.hidden = false;
            btnLogout.hidden = true;
            if (btnManual) btnManual.hidden = true;
        }
    }

    function startApp() {
        if (appStarted) return;
        appStarted = true;
        initTabs();
        initMap();
        initRealizadosControles();
        // En modo consulta no se inicializan los flujos de despacho/asignación.
        if (!MODO_CONSULTA) {
            initModal();
            initManualModal();
            initDespachosControles();
        } else {
            // Desbloquear el audio en el primer gesto del conductor.
            document.addEventListener("click", desbloquearAudio, { once: true });
            document.addEventListener("touchstart", desbloquearAudio, { once: true });
            // Botón de instalación de la PWA (aparece cuando Chrome la reconoce).
            configurarInstalacion();
            // Botón de ayuda en la barra superior.
            const btnAyuda = document.getElementById("btnAyuda");
            if (btnAyuda) btnAyuda.addEventListener("click", mostrarAyuda);
            // Pantalla obligatoria para activar las notificaciones.
            mostrarNotifGate();
            // Si ya hay permiso, registrar el push para recibir avisos con la app cerrada.
            if ("Notification" in window && Notification.permission === "granted") registrarPush();
        }
        if (navigator.onLine) {
            cargarInicial();
            suscribirRealtime();
            suscribirRealizadosRealtime();
            cargarRealizados();
            if (!MODO_CONSULTA) {
                cargarVehiculos();
                cargarConductores();
            }
        } else {
            setConnection("offline");
        }
    }

    initAuth();
})();
