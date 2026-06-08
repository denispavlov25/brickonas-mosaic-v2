/**
 * Vector PDF build-instructions renderer for the BRICKONAS mosaic configurator.
 *
 * Replaces the old approach of rasterising each instruction page to a JPEG/PNG
 * canvas and embedding it via pdf.addImage(). Instead every page is drawn with
 * native jsPDF vector primitives (rects, circles, text). The result is:
 *   - dramatically smaller files (compressed vector studs + text vs. raster)
 *   - crisp at any zoom / print size
 *   - identical instruction CONTENT: same stud→number mapping, per-colour counts,
 *     plate/section layout, color legend and page breaks.
 *
 * Size strategy (verified): jsPDF `compress:true` (zlib content streams) plus
 * grouping all fills by colour (one setFillColor per colour per page) keeps a
 * full 96×96 instruction set to a few hundred KB instead of tens of MB.
 *
 * Requires jsPDF 2.x (window.jspdf.jsPDF) and the following globals from algo.js
 * / bricklink-colors.js / i18n.js:
 *   rgbToHex, inverseHex, getUsedPixelsStudMap, HEX_TO_COLOR_NAME,
 *   translateColor, t(), PIXEL_TYPE_OPTIONS.
 *
 * Units: all measurements are in millimetres (jsPDF unit "mm").
 */

(function (global) {
    "use strict";

    // ---- Page + layout constants (mm) -------------------------------------
    var PAGE_W = 297; // A4 landscape
    var PAGE_H = 210;
    var MARGIN = 12;

    var GREEN = "#1B5E20";
    var DARK = "#202020";
    var GREY = "#888888";

    function getJsPDF() {
        if (global.jspdf && global.jspdf.jsPDF) return global.jspdf.jsPDF;
        if (typeof global.jsPDF === "function") return global.jsPDF;
        throw new Error("jsPDF 2.x not loaded");
    }

    // Decide whether a stud is rendered as a circle (round plate / stud) or a
    // square (tile). Mirrors drawPixel() in algo.js.
    function studIsRound(pixelType) {
        if (typeof PIXEL_TYPE_OPTIONS === "undefined") return true;
        return [PIXEL_TYPE_OPTIONS[0].number, PIXEL_TYPE_OPTIONS[1].number].indexOf(pixelType) !== -1;
    }
    function studHasTopStud(pixelType) {
        if (typeof PIXEL_TYPE_OPTIONS === "undefined") return false;
        return [
            PIXEL_TYPE_OPTIONS[1].number,
            PIXEL_TYPE_OPTIONS[3].number,
            PIXEL_TYPE_OPTIONS[4].number,
            PIXEL_TYPE_OPTIONS[6].number,
            PIXEL_TYPE_OPTIONS[7].number,
        ].indexOf(pixelType) !== -1;
    }

    function colorName(hex) {
        if (typeof HEX_TO_COLOR_NAME !== "undefined" && HEX_TO_COLOR_NAME[hex]) {
            var name = HEX_TO_COLOR_NAME[hex];
            if (typeof translateColor === "function") return translateColor(name) || name;
            return name;
        }
        return hex;
    }

    // Pick a readable text colour (black or white) for a given background hex.
    function textOn(hex) {
        if (typeof inverseHex === "function") return inverseHex(hex);
        var h = hex.replace("#", "");
        var r = parseInt(h.substr(0, 2), 16),
            g = parseInt(h.substr(2, 2), 16),
            b = parseInt(h.substr(4, 2), 16);
        return 0.299 * r + 0.587 * g + 0.114 * b > 140 ? "#000000" : "#ffffff";
    }

    // Build a stable hex→number map across the whole document.
    function buildStudToNumber(availableStudHexList) {
        var map = {};
        availableStudHexList.forEach(function (hex, i) {
            map[hex] = i + 1;
        });
        return map;
    }

    // Group the (i,j) cells of a plateWidth×plateWidth RGBA array by hex colour.
    // Returns { hex: [{i,j}, ...] } so callers can set the fill colour once per
    // colour — this is the key file-size optimisation.
    function groupCellsByColor(pixelArray, plateWidth) {
        var groups = {};
        for (var i = 0; i < plateWidth; i++) {
            for (var j = 0; j < plateWidth; j++) {
                var idx = (i * plateWidth + j) * 4;
                var hex = rgbToHex(pixelArray[idx], pixelArray[idx + 1], pixelArray[idx + 2]);
                (groups[hex] || (groups[hex] = [])).push(i * plateWidth + j);
            }
        }
        return groups;
    }

    // ---- Color legend (vector) --------------------------------------------
    // Draws a "Farben" panel: header bar, one row per colour with a swatch
    // (numbered), the per-colour count ("X N") and the translated colour name.
    // Returns { x, y, w, h } of the drawn box.
    function drawLegend(pdf, opts) {
        var studMap = opts.studMap;
        var hexList = opts.hexList; // already filtered to colours on this page
        var studToNumber = opts.studToNumber;
        var pixelType = opts.pixelType;
        var x = opts.x;
        var y = opts.y;
        var maxH = opts.maxH || PAGE_H - 2 * MARGIN;

        var swatch = 6.5; // mm
        var rowH = 8.5;
        var headerH = 9;
        var padX = 3;
        var pad = 2;

        var rows = hexList.length;
        var needed = headerH + rows * rowH + pad * 2;
        if (needed > maxH && rows > 0) {
            var scale = (maxH - headerH - pad * 2) / (rows * rowH);
            rowH = Math.max(4.5, rowH * scale);
            swatch = Math.min(swatch, rowH * 0.78);
        }

        // Measure widest content for the box width.
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(8);
        var maxText = pdf.getTextWidth(opts.title || "Farben");
        hexList.forEach(function (hex) {
            pdf.setFont("helvetica", "bold");
            pdf.setFontSize(8);
            var w1 = pdf.getTextWidth("X " + (studMap[hex] || 0));
            pdf.setFont("helvetica", "normal");
            pdf.setFontSize(7);
            var w2 = pdf.getTextWidth(colorName(hex));
            var w = Math.max(w1, w2);
            if (w > maxText) maxText = w;
        });

        var boxW = padX + swatch + 2 + maxText + padX;
        var boxH = headerH + rows * rowH + pad * 2;

        // Zebra rows
        pdf.setFillColor(245, 245, 245);
        for (var zi = 1; zi < rows; zi += 2) {
            pdf.rect(x, y + headerH + pad + zi * rowH, boxW, rowH, "F");
        }

        // Header bar
        pdf.setFillColor(GREEN);
        pdf.rect(x, y, boxW, headerH, "F");
        pdf.setTextColor("#ffffff");
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(8.5);
        pdf.text(opts.title || "Farben", x + boxW / 2, y + headerH / 2 + 1, {
            align: "center",
            baseline: "middle",
        });

        var round = studIsRound(pixelType);
        pdf.setLineWidth(0.2);
        hexList.forEach(function (hex, i) {
            var rowY = y + headerH + pad + i * rowH;
            var cy = rowY + rowH / 2;
            var sx = x + padX;
            var sy = cy - swatch / 2;

            pdf.setFillColor(hex);
            pdf.setDrawColor(textOn(hex));
            if (round) {
                pdf.circle(sx + swatch / 2, cy, swatch / 2, "FD");
            } else {
                pdf.rect(sx, sy, swatch, swatch, "FD");
            }
            pdf.setTextColor(textOn(hex));
            pdf.setFont("helvetica", "bold");
            pdf.setFontSize(Math.min(7, swatch * 0.95));
            pdf.text("" + (studToNumber[hex] || i + 1), sx + swatch / 2, cy + 0.2, {
                align: "center",
                baseline: "middle",
            });

            var tx = sx + swatch + 2;
            pdf.setTextColor(DARK);
            pdf.setFont("helvetica", "bold");
            pdf.setFontSize(8);
            pdf.text("X " + (studMap[hex] || 0), tx, cy - 0.5, { baseline: "bottom" });
            pdf.setTextColor("#555555");
            pdf.setFont("helvetica", "normal");
            pdf.setFontSize(7);
            pdf.text(colorName(hex), tx, cy + 0.7, { baseline: "top" });
        });

        pdf.setDrawColor(GREY);
        pdf.setLineWidth(0.3);
        pdf.rect(x, y, boxW, boxH, "S");

        return { x: x, y: y, w: boxW, h: boxH };
    }

    // ---- One instruction page (plate / detail block) ----------------------
    function drawInstructionPage(pdf, params) {
        var pixelArray = params.pixelArray;
        var plateWidth = params.plateWidth;
        var availableStudHexList = params.availableStudHexList;
        var studToNumber = params.studToNumber;
        var label = params.label;
        var pixelType = params.pixelType;
        var variableDims = params.variableDims || null;
        var overviewContext = params.overviewContext || null;

        var studMap = getUsedPixelsStudMap(pixelArray);
        var visibleHexList = availableStudHexList.filter(function (hex) {
            return (studMap[hex] || 0) > 0;
        });

        // Layout: legend column on the left, grid on the right.
        var legendW = 46;
        var gridLeft = MARGIN + legendW + 6;
        var gridTop = MARGIN + 10;
        var gridMaxW = PAGE_W - MARGIN - gridLeft;
        var gridMaxH = PAGE_H - gridTop - MARGIN;
        var cell = Math.min(gridMaxW, gridMaxH) / plateWidth;
        var gridSize = cell * plateWidth;

        // Title
        pdf.setTextColor(DARK);
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(16);
        pdf.text(t("pdfSection") + " " + label, gridLeft, MARGIN + 5);

        var round = studIsRound(pixelType);
        var hasTop = studHasTopStud(pixelType);
        var r = cell / 2;
        var drawStudOutline = cell >= 3; // skip per-stud strokes when tiny
        var showNumbers = cell >= 4.5;

        // --- Studs, grouped by colour (one fill colour set per colour) ---
        var groups = groupCellsByColor(pixelArray, plateWidth);
        pdf.setLineWidth(Math.max(0.08, cell * 0.04));
        Object.keys(groups).forEach(function (hex) {
            pdf.setFillColor(hex);
            if (drawStudOutline) pdf.setDrawColor(textOn(hex));
            var style = drawStudOutline ? "FD" : "F";
            var cells = groups[hex];
            for (var k = 0; k < cells.length; k++) {
                var lin = cells[k];
                var ci = Math.floor(lin / plateWidth);
                var cj = lin % plateWidth;
                var px = gridLeft + cj * cell;
                var py = gridTop + ci * cell;
                if (round) {
                    pdf.circle(px + r, py + r, r, style);
                } else {
                    pdf.rect(px, py, cell, cell, style);
                }
            }
            if (hasTop && cell >= 4) {
                pdf.setDrawColor(textOn(hex));
                for (var k2 = 0; k2 < cells.length; k2++) {
                    var lin2 = cells[k2];
                    var ti = Math.floor(lin2 / plateWidth);
                    var tj = lin2 % plateWidth;
                    pdf.circle(gridLeft + tj * cell + r, gridTop + ti * cell + r, r * 0.6, "S");
                }
            }
        });

        // --- Stud numbers, grouped by text colour (black / white) ---
        if (showNumbers) {
            pdf.setFont("helvetica", "normal");
            pdf.setFontSize(Math.max(3.5, cell * 0.55));
            ["#000000", "#ffffff"].forEach(function (tc) {
                pdf.setTextColor(tc);
                Object.keys(groups).forEach(function (hex) {
                    if (textOn(hex) !== tc) return;
                    var num = "" + (studToNumber[hex] || "");
                    if (!num) return;
                    var cells = groups[hex];
                    for (var k = 0; k < cells.length; k++) {
                        var lin = cells[k];
                        var ci = Math.floor(lin / plateWidth);
                        var cj = lin % plateWidth;
                        pdf.text(num, gridLeft + cj * cell + r, gridTop + ci * cell + r, {
                            align: "center",
                            baseline: "middle",
                        });
                    }
                });
            });
        }

        // Variable-piece overlay (plate dimension boundaries), if present.
        if (variableDims) {
            pdf.setDrawColor(GREY);
            pdf.setLineWidth(Math.max(0.15, cell * 0.05));
            for (var vi = 0; vi < plateWidth; vi++) {
                for (var vj = 0; vj < plateWidth; vj++) {
                    var piece = variableDims[vi] && variableDims[vi][vj];
                    if (piece != null) {
                        pdf.rect(
                            gridLeft + vj * cell,
                            gridTop + vi * cell,
                            cell * piece[1],
                            cell * piece[0],
                            "S"
                        );
                    }
                }
            }
        }

        // Grid outer border
        pdf.setDrawColor(DARK);
        pdf.setLineWidth(0.4);
        pdf.rect(gridLeft, gridTop, gridSize, gridSize, "S");

        // Legend (left column)
        drawLegend(pdf, {
            studMap: studMap,
            hexList: visibleHexList,
            studToNumber: studToNumber,
            pixelType: pixelType,
            x: MARGIN,
            y: gridTop,
            maxH: PAGE_H - gridTop - MARGIN,
        });

        // Plate-overview thumbnail (where this detail block sits), if provided.
        if (overviewContext) {
            var thumbX = gridLeft + gridSize + 4;
            if (thumbX + 26 > PAGE_W - MARGIN) thumbX = PAGE_W - MARGIN - 26;
            drawOverviewThumb(pdf, overviewContext, pixelType, { x: thumbX, y: gridTop, size: 26 });
        }
    }

    // Small flat thumbnail of the full plate with the active block outlined.
    function drawOverviewThumb(pdf, overview, pixelType, layout) {
        var fullPlateArray = overview.fullPlateArray;
        var plateWidth = overview.plateWidth;
        var size = layout.size;
        var x = layout.x;
        var y = layout.y;
        var cell = size / plateWidth;

        pdf.setTextColor(DARK);
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(7);
        pdf.text(t("pdfOverviewLabel"), x, y - 1.5);

        // Flat rects, grouped by colour.
        var groups = groupCellsByColor(fullPlateArray, plateWidth);
        Object.keys(groups).forEach(function (hex) {
            pdf.setFillColor(hex);
            var cells = groups[hex];
            for (var k = 0; k < cells.length; k++) {
                var lin = cells[k];
                var ci = Math.floor(lin / plateWidth);
                var cj = lin % plateWidth;
                pdf.rect(x + cj * cell, y + ci * cell, cell + 0.05, cell + 0.05, "F");
            }
        });
        pdf.setDrawColor(DARK);
        pdf.setLineWidth(0.25);
        pdf.rect(x, y, size, size, "S");

        pdf.setDrawColor(GREEN);
        pdf.setLineWidth(0.7);
        pdf.rect(
            x + overview.blockCol * overview.blockSize * cell,
            y + overview.blockRow * overview.blockSize * cell,
            overview.blockSize * cell,
            overview.blockSize * cell,
            "S"
        );
    }

    // ---- Title / overview page (vector) -----------------------------------
    function drawTitlePage(pdf, params) {
        var pixelArray = params.pixelArray;
        var width = params.width;
        var plateWidth = params.plateWidth;
        var plateHeight = params.plateHeight;
        var availableStudHexList = params.availableStudHexList;
        var studToNumber = params.studToNumber;
        var pixelType = params.pixelType;
        var pixelWidthCm = params.pixelWidthCm;

        var studMap = getUsedPixelsStudMap(pixelArray);
        var height = pixelArray.length / (4 * width);
        var numPlates = pixelArray.length / (4 * plateWidth * plateWidth);
        var platesPerRow = width / plateWidth;
        var platesPerCol = numPlates / platesPerRow;

        // Header / wordmark
        pdf.setTextColor(GREEN);
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(26);
        pdf.text("BRICKONAS", MARGIN, MARGIN + 8);
        pdf.setFontSize(13);
        pdf.setTextColor(DARK);
        pdf.text("BrickPic - " + t("pdfInstructions"), MARGIN, MARGIN + 15);

        // Metadata card
        var widthCm = (width * pixelWidthCm).toFixed(1);
        var heightCm = (height * pixelWidthCm).toFixed(1);
        var rows = [
            [t("pdfResolution"), width + " x " + height],
            [t("pdfPlates"), platesPerRow + " x " + platesPerCol + " (" + numPlates + " " + t("pdfTotal") + ")"],
            [t("pdfPlateSize"), plateWidth + " x " + plateHeight],
            [t("pdfSize"), widthCm + " x " + heightCm + " cm"],
        ];
        var cardX = MARGIN;
        var cardY = MARGIN + 22;
        var rowH = 7;
        var labelW = 0;
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(9);
        rows.forEach(function (rw) {
            var w = pdf.getTextWidth(rw[0]);
            if (w > labelW) labelW = w;
        });
        var valW = 0;
        pdf.setFont("helvetica", "normal");
        rows.forEach(function (rw) {
            var w = pdf.getTextWidth(rw[1]);
            if (w > valW) valW = w;
        });
        var cardW = 6 + labelW + 6 + valW + 6;
        var cardH = rows.length * rowH + 4;
        pdf.setFillColor("#f7f7f7");
        pdf.setDrawColor("#dddddd");
        pdf.setLineWidth(0.3);
        pdf.rect(cardX, cardY, cardW, cardH, "FD");
        rows.forEach(function (rw, i) {
            var ry = cardY + 4 + i * rowH + rowH / 2;
            pdf.setTextColor("#444444");
            pdf.setFont("helvetica", "bold");
            pdf.setFontSize(9);
            pdf.text(rw[0], cardX + 6, ry, { baseline: "middle" });
            pdf.setTextColor("#1a1a1a");
            pdf.setFont("helvetica", "normal");
            pdf.text(rw[1], cardX + 6 + labelW + 6, ry, { baseline: "middle" });
        });

        // Plate-arrangement grid (only when >1 plate)
        if (numPlates > 1) {
            var pgX = cardX + cardW + 10;
            var pgY = cardY;
            pdf.setTextColor("#444444");
            pdf.setFont("helvetica", "bold");
            pdf.setFontSize(9);
            pdf.text("Plattenanordnung", pgX, pgY - 1);
            var psize = 9;
            pdf.setFillColor("#f7f7f7");
            pdf.setDrawColor("#888888");
            pdf.setLineWidth(0.2);
            for (var p = 0; p < numPlates; p++) {
                var hor = ((p * plateWidth) % width) / plateWidth;
                var ver = Math.floor((p * plateWidth) / width);
                var px = pgX + hor * psize;
                var py = pgY + ver * psize;
                pdf.rect(px, py, psize - 1, psize - 1, "FD");
                pdf.setTextColor("#1a1a1a");
                pdf.setFontSize(5);
                pdf.text("" + (p + 1), px + (psize - 1) / 2, py + (psize - 1) / 2, {
                    align: "center",
                    baseline: "middle",
                });
            }
        }

        // Mosaic preview as a flat vector grid (rects, grouped by colour).
        var prevTop = cardY + cardH + 8;
        var availW = PAGE_W - 2 * MARGIN - 56; // leave room for the legend on the right
        var availH = PAGE_H - prevTop - MARGIN;
        var pcell = Math.min(availW / width, availH / height);
        var pw = pcell * width;
        var ph = pcell * height;
        var prevX = MARGIN;
        var pgroups = {};
        for (var gi = 0; gi < width * height; gi++) {
            var hx = rgbToHex(pixelArray[gi * 4], pixelArray[gi * 4 + 1], pixelArray[gi * 4 + 2]);
            (pgroups[hx] || (pgroups[hx] = [])).push(gi);
        }
        Object.keys(pgroups).forEach(function (hex) {
            pdf.setFillColor(hex);
            var cells = pgroups[hex];
            for (var k = 0; k < cells.length; k++) {
                var lin = cells[k];
                var yy = Math.floor(lin / width);
                var xx = lin % width;
                pdf.rect(prevX + xx * pcell, prevTop + yy * pcell, pcell + 0.05, pcell + 0.05, "F");
            }
        });
        pdf.setDrawColor(DARK);
        pdf.setLineWidth(0.3);
        pdf.rect(prevX, prevTop, pw, ph, "S");
        pdf.setDrawColor("#333333");
        pdf.setLineWidth(0.25);
        for (var c = 1; c < platesPerRow; c++) {
            pdf.line(prevX + c * plateWidth * pcell, prevTop, prevX + c * plateWidth * pcell, prevTop + ph);
        }
        for (var rr = 1; rr < platesPerCol; rr++) {
            pdf.line(prevX, prevTop + rr * plateWidth * pcell, prevX + pw, prevTop + rr * plateWidth * pcell);
        }

        // Full colour legend on the right of the title page.
        drawLegend(pdf, {
            studMap: studMap,
            hexList: availableStudHexList,
            studToNumber: studToNumber,
            pixelType: pixelType,
            x: PAGE_W - MARGIN - 50,
            y: prevTop,
            maxH: PAGE_H - prevTop - MARGIN,
        });
    }

    // ---- Public: build the whole document ---------------------------------
    async function buildInstructionsPdf(ctx) {
        var jsPDFCtor = getJsPDF();
        // compress:true → zlib content streams. This is the single biggest
        // file-size lever for vector grids (≈14× smaller, verified).
        var pdf = new jsPDFCtor({ orientation: "landscape", unit: "mm", format: "a4", compress: true });

        var resultImage = ctx.resultImage;
        var width = ctx.targetResolution[0];
        var PLATE_WIDTH = ctx.PLATE_WIDTH;
        var availableStudHexList = ctx.availableStudHexList;
        var studToNumber = buildStudToNumber(availableStudHexList);
        var pixelType = ctx.pixelType;
        var BLOCK_SIZE = ctx.blockSize || 16;

        drawTitlePage(pdf, {
            pixelArray: resultImage,
            width: width,
            plateWidth: PLATE_WIDTH,
            plateHeight: ctx.PLATE_HEIGHT,
            availableStudHexList: availableStudHexList,
            studToNumber: studToNumber,
            pixelType: pixelType,
            pixelWidthCm: ctx.pixelWidthCm,
        });

        var totalPlates = resultImage.length / (4 * PLATE_WIDTH * PLATE_WIDTH);

        var jobs = [];
        for (var i = 0; i < totalPlates; i++) {
            var subPixelArray = ctx.getSubPixelArray(resultImage, i, width, PLATE_WIDTH);
            var row = Math.floor((i * PLATE_WIDTH) / width);
            var col = i % (width / PLATE_WIDTH);
            var variableDimsForPage =
                ctx.variablePixelPieceDimensions == null
                    ? null
                    : ctx.getSubPixelMatrix(
                          ctx.variablePixelPieceDimensions,
                          col * PLATE_WIDTH,
                          row * PLATE_WIDTH,
                          PLATE_WIDTH,
                          PLATE_WIDTH
                      );

            jobs.push({
                pixelArray: subPixelArray,
                plateWidth: PLATE_WIDTH,
                label: "" + (i + 1),
                variableDims: variableDimsForPage,
            });

            var blocksPerSide = PLATE_WIDTH / BLOCK_SIZE;
            if (blocksPerSide > 1 && Number.isInteger(blocksPerSide)) {
                var blockIdx = 0;
                for (var br = 0; br < blocksPerSide; br++) {
                    for (var bc = 0; bc < blocksPerSide; bc++) {
                        blockIdx++;
                        var blockArray = ctx.getSubBlockFromPlate(subPixelArray, PLATE_WIDTH, bc, br, BLOCK_SIZE);
                        var blockVariableDims =
                            variableDimsForPage == null
                                ? null
                                : ctx.getSubPixelMatrix(
                                      variableDimsForPage,
                                      bc * BLOCK_SIZE,
                                      br * BLOCK_SIZE,
                                      BLOCK_SIZE,
                                      BLOCK_SIZE
                                  );
                        jobs.push({
                            pixelArray: blockArray,
                            plateWidth: BLOCK_SIZE,
                            label: i + 1 + "." + blockIdx,
                            variableDims: blockVariableDims,
                            overviewContext: {
                                fullPlateArray: subPixelArray,
                                plateWidth: PLATE_WIDTH,
                                blockCol: bc,
                                blockRow: br,
                                blockSize: BLOCK_SIZE,
                            },
                        });
                    }
                }
            }
        }

        for (var p = 0; p < jobs.length; p++) {
            if (ctx.sleep) await ctx.sleep(0);
            pdf.addPage();
            var job = jobs[p];
            drawInstructionPage(pdf, {
                pixelArray: job.pixelArray,
                plateWidth: job.plateWidth,
                availableStudHexList: availableStudHexList,
                studToNumber: studToNumber,
                label: job.label,
                pixelType: pixelType,
                variableDims: job.variableDims,
                overviewContext: job.overviewContext,
            });
            if (ctx.onProgress) ctx.onProgress((p + 2) / (jobs.length + 1));
        }

        return pdf;
    }

    global.BkVectorPdf = {
        buildInstructionsPdf: buildInstructionsPdf,
        drawInstructionPage: drawInstructionPage,
        drawTitlePage: drawTitlePage,
        drawLegend: drawLegend,
    };
})(typeof window !== "undefined" ? window : this);
