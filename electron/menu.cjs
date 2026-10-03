"use strict";
// Native menu labels are app-owned; OS authentication/file dialogs retain the OS language.
const labels = Object.freeze({
 en: ["File", "Edit", "View", "Window", "Help", "About Tableline", "Quit Tableline", "Close Window", "Undo", "Redo", "Cut", "Copy", "Paste", "Select All", "Toggle Full Screen", "Minimize", "Zoom", "Tableline on GitHub"],
 it: ["File", "Modifica", "Vista", "Finestra", "Aiuto", "Informazioni su Tableline", "Esci da Tableline", "Chiudi finestra", "Annulla", "Ripristina", "Taglia", "Copia", "Incolla", "Seleziona tutto", "Schermo intero", "Riduci a icona", "Zoom", "Tableline su GitHub"],
 fr: ["Fichier", "Édition", "Affichage", "Fenêtre", "Aide", "À propos de Tableline", "Quitter Tableline", "Fermer la fenêtre", "Annuler", "Rétablir", "Couper", "Copier", "Coller", "Tout sélectionner", "Plein écran", "Réduire", "Zoom", "Tableline sur GitHub"],
 de: ["Datei", "Bearbeiten", "Ansicht", "Fenster", "Hilfe", "Über Tableline", "Tableline beenden", "Fenster schließen", "Rückgängig", "Wiederholen", "Ausschneiden", "Kopieren", "Einfügen", "Alles auswählen", "Vollbild", "Minimieren", "Zoom", "Tableline auf GitHub"],
 es: ["Archivo", "Editar", "Ver", "Ventana", "Ayuda", "Acerca de Tableline", "Salir de Tableline", "Cerrar ventana", "Deshacer", "Rehacer", "Cortar", "Copiar", "Pegar", "Seleccionar todo", "Pantalla completa", "Minimizar", "Zoom", "Tableline en GitHub"],
});
function menuTemplate(language, platform = process.platform) {
 if (typeof language !== "string" || !Object.hasOwn(labels, language)) throw new Error("Unsupported application language.");
 const l = labels[language];
 const appMenu = { label: "Tableline", submenu: [{ label: l[5], role: "about" }, { type: "separator" }, { label: l[6], role: "quit" }] };
 const menus = [
  { label: l[0], submenu: [{ label: l[7], role: "close" }, ...(platform === "darwin" ? [] : [{ label: l[6], role: "quit" }])] },
  { label: l[1], submenu: ["undo", "redo", "cut", "copy", "paste", "selectAll"].map((role, index) => ({ role, label: l[8 + index] })) },
  { label: l[2], submenu: [{ label: l[14], role: "togglefullscreen" }] },
  { label: l[3], submenu: [{ label: l[15], role: "minimize" }, { label: l[16], role: "zoom" }] },
 ];
 // No external browser destinations or privileged tools are exposed by a menu label.
 const help = { label: l[4], submenu: [{ label: l[5], role: "about" }] };
 return platform === "darwin" ? [appMenu, ...menus, help] : [...menus, help];
}
function setMenuLanguage(Menu, language) {
 const template = menuTemplate(language);
 if (typeof Menu?.buildFromTemplate === "function" && typeof Menu?.setApplicationMenu === "function")
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
 return { language };
}
module.exports = { menuTemplate, setMenuLanguage, languages: Object.keys(labels) };
