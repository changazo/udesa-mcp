/** ADR-136: resumen de sección sintético con una tabla de horarios como la guarda el editor de Moodle. */
// Como lo guarda el editor de Moodle: encabezados en <td>, <tbody> sin <thead>, estilos, imagen, enlaces y data-*.
export const HORARIOS = `<p><img src="@@PLUGINFILE@@/icono.png" alt="Horarios" width="32" class="img-fluid"> <strong>Horarios</strong></p>
<table class="table" style="width: 100%;" data-origen="moodle">
<tbody>
<tr><td style="width: 20%;"><strong>Clase</strong></td><td>Profesor</td><td>Día</td><td>Hora</td><td>Enlace</td></tr>
<tr><td>Teórica</td><td>Ana Pérez</td><td><p><span style="color: #000000;">Martes (extraordinario)</span></p></td><td>18:00</td><td><a href="https://meet.google.com/aaa-bbbb-ccc">Meet</a></td></tr>
<tr><td>Consultas</td><td>Juan Cruz Changazo</td><td><p><span style="color: #000000;">Martes (extraordinario)</span></p></td><td><span style="font-size: 0.9rem;">19:00 a 20:30</span></td><td><a href="https://meet.google.com/tzg-yemr-aqq" target="_blank">Meet</a></td></tr>
</tbody>
</table>`;

export const PATCH = { headers_contain: ["Clase", "Profesor", "Día"], row_match: { Clase: "Consultas", Profesor: "Juan Cruz Changazo" }, column: "Día", expected_text: "Martes (extraordinario)", replacement_text: "Miércoles" };

