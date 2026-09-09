# Avisos de renovación por WhatsApp

Estado a 8 de septiembre de 2026.

## Dónde estamos

Las dos plantillas de Meta ya están creadas y **en revisión**:

| Plantilla | Categoría | Idioma | Variables |
|---|---|---|---|
| `renewlet_renovacion_mensual` | Utilidad | Spanish (`es`) | 4 |
| `renewlet_renovacion_anual` | Utilidad | Spanish (`es`) | 5 + encabezado |

La antigua `renewlet_notificacion` sigue activa, en Marketing y en Spanish (SPA,
`es_ES`). No la borres todavía: es la que funciona hoy.

Lo que falta es el payload de renewlet, y después el nodo de n8n.

## Por qué llegaban mal los mensajes

Esto es lo que manda hoy el webhook (ejecución real del 8 sep a las 08:00):

```
title:     "Renewlet subscription reminder"
content:   "Expired (next billing date not updated):
            - Clalaude: 2026-09-04, 21 EUR (expired)
            - Spotity: 2019-10-01, 20.99 EUR (expired)"
timestamp: "2026-09-08 08:00 Europe/Madrid"
```

Tres problemas, y el primero tapaba a los otros dos:

1. Los campos de la plantilla en n8n estaban en modo **Fixed** en lugar de
   **Expression**, así que se enviaban las llaves como texto literal. n8n guarda
   las expresiones con un `=` delante internamente; esos campos no lo tenían.
2. `title` no es el nombre del servicio, es una cadena fija en inglés. Aunque la
   expresión funcionase, el mensaje diría "Aviso de Renewlet sobre Renewlet
   subscription reminder".
3. `content` tiene saltos de línea, y **los parámetros de plantilla de Meta no
   admiten saltos de línea, tabuladores, ni cuatro espacios seguidos**. En el
   momento en que la expresión se evalúe, Meta rechaza la llamada. El bug 1
   estaba escondiendo el bug 3.

Y de fondo, el aviso no es de vencimiento próximo: renewlet dice "next billing
date not updated" y lista suscripciones caducadas desde 2019. Las fechas de
facturación no avanzan de ciclo. Ese es el bug que genera estos avisos.

## Regla de oro: el evento nuevo es aditivo

**No cambies el webhook ni el payload que ya existe.** Lo consumen tres
workflows de n8n, y los tres leen `body.title` y `body.content`:

- `Renewlet → Slack`
- `Renewlet → Backup Email`
- `Renewlet → Google Sheets Sync`

Si cambias el formato compartido, el WhatsApp se arregla y los otros dos se
rompen en silencio. Así que los avisos por suscripción son un **evento nuevo por
un webhook nuevo**, y el resumen actual sigue igual.

Eso también encaja con la forma natural de cada aviso: el resumen agrupado es lo
correcto para "caducadas y revisar", y el mensaje por suscripción para "se
renueva pronto".

## Cambio 1: payload nuevo, un POST por suscripción

```json
{
  "event": "renewal_upcoming",
  "billing_cycle": "annual",
  "reminder_window": 30,
  "service": "Adobe Creative Cloud",
  "next_billing_date": "2026-10-15",
  "amount": "239,88 EUR",
  "price_note": "sube desde 199,00 EUR"
}
```

Reglas que evitan que Meta rechace el envío:

- Ningún campo puede llegar vacío ni nulo. Un parámetro vacío no deja un hueco en
  el mensaje, tumba el envío entero.
- Ningún campo puede contener saltos de línea.
- `amount` ya formateado como cadena, con la moneda dentro, para no depender de
  cómo serialice los decimales cada lenguaje.
- `billing_cycle` es `annual` o `monthly`.

### `reminder_window` es la pieza clave

Hace tres cosas a la vez:

- Es el número que el mensaje imprime como días restantes, así que **n8n deja de
  calcular fechas**. Nada de aritmética duplicada ni líos de zona horaria.
- Es la clave de deduplicación: renewlet apunta que ya mandó la ventana de 30 de
  esa suscripción y no la repite al día siguiente.
- Es lo que decidió el propio planificador, así que no puede discrepar de por qué
  se disparó el aviso.

Ventanas por ciclo:

- `annual`: **30 y 7 días** antes
- `monthly`: **7 días** antes, y ya

Una mensual de 9 euros no merece tres avisos. Si los mandas, en un mes dejas de
leerlos, y el día que llegue el de la anual de 240 tampoco lo leerás. El valor de
estos avisos se gasta si son demasiados.

No hay aviso de 1 día. A un día no puedes cancelar con efecto (muchos servicios
piden preaviso), así que no es un aviso de decisión sino de cargo, y mezclar las
dos cosas en la misma plantilla es lo que acostumbra a descartarla sin leerla. Si
quieres el aviso de cargo, que vaya por email.

### `price_note`

Una frase, nunca vacía, comparando con el importe del ciclo anterior:

- `sube desde 199,00 EUR`
- `igual que el año pasado`
- `primer cobro`

Es el dato que hace posible la decisión. Sin él tienes que abrir el panel para
saber si el precio cambió, y entonces el mensaje no sirve para decidir.

Resolverlo como frase y no como un campo "precio anterior" evita el problema de
que ese campo no exista el primer año y tumbe el envío.

### Guarda de seguridad

Si en el momento de enviar la fecha de cobro ya pasó, no se manda nada. Un aviso
de "cancela antes del 15/10" que llega el 16 es peor que el silencio.

### Separa los eventos

- `renewal_upcoming`: se renueva pronto. Uno por suscripción. Va por WhatsApp.
- El resumen de caducadas y fechas sin actualizar es un informe, no un aviso.
  Sigue por el webhook viejo, hacia email y Slack, donde una lista tiene sentido.

## Cambio 2: las plantillas de Meta (ya creadas)

### `renewlet_renovacion_mensual`

Sin encabezado, sin pie. Cuerpo:

```
🔔 Aviso de renovación de {{1}}.
Se renueva el {{2}}.
Importe: {{3}}
Días para decidir: {{4}}
Puedes modificarla o cancelarla desde tu panel.
```

Orden de variables: servicio, fecha, importe, días.

Muestras: `Netflix`, `15/09/2026`, `8,99 EUR`, `7`.

### `renewlet_renovacion_anual`

Encabezado (texto, estático, sin emoji): `Renovación anual próxima`

Cuerpo:

```
Tu suscripción a *{{1}}* se renueva el *{{2}}*.
Importe: *{{3}}*
Cambio de precio: {{4}}
Días para decidir: {{5}}
Si no quieres pagar otro año, cancélalo antes de esa fecha.
```

Muestras: `Adobe Creative Cloud`, `15/10/2026`, `239,88 EUR`,
`sube desde 199,00 EUR`, `30`.

Decisiones de diseño que conviene no deshacer:

- **La fecha va en negrita junto al nombre, no el número de días.** La fecha es
  verdad siempre, aunque el envío se retrase unas horas. El número de días es el
  dato frágil de cualquier diseño de esto.
- El segundo label dice "Cambio de precio" y no "Precio" porque junto a
  "Importe" son casi sinónimos en español y el ojo resbala justo por el que
  importa.
- "Días para decidir: 7" en lugar de "se renueva en 7 días" porque las plantillas
  no admiten condicionales, y con la segunda forma el día que falte uno solo
  llegaría "se renueva en 1 días".
- Lo que diferencia a la anual no es el emoji, es que **tiene encabezado y la
  mensual no**. WhatsApp lo pinta en negrita encima del cuerpo, así que ya llega
  marcada como distinta sin ningún icono.

### Botón, en las dos

Tipo "Ir al sitio web", URL **estática**, texto `Ver en Renewlet`, URL
`https://renewlet.daniellorente.dev`.

Estática y no dinámica a propósito: una URL dinámica lleva una variable al final y
eso es un parámetro más que renewlet tiene que rellenar siempre. Si algún día
llega vacío, Meta rechaza el envío y no llega ni el aviso.

Cuando renewlet tenga página por suscripción, merece la pena pasarla a dinámica.
Ese día el payload necesita un `id` o un `slug` garantizado.

### Dos plantillas y no una

Además de que el texto es distinto, la puntuación de calidad y las pausas de Meta
son **por plantilla**. Un aviso mensual ruidoso que acabe marcado como molesto no
puede arrastrar al anual, que es justamente el que ahorra dinero.

## Cambio 3: n8n

Workflow **nuevo**, llamado `Renewlet → WhatsApp`, con su propio nodo Webhook
apuntando al evento nuevo. El que hoy se llama `Renewlet → Slack` (id
`HFCMa4PDksl8Ild3`) se queda haciendo solo Slack, que es lo que su nombre dice.
Hoy manda WhatsApp a pesar del nombre, y eso cuesta media hora de confusión cada
vez que vuelves al proyecto.

Dentro, un nodo **If** con la condición:

```
{{ $json.body.billing_cycle === 'annual' }}
```

Por la salida verdadera, el nodo que usa `renewlet_renovacion_anual` con cinco
parámetros. Por la falsa, el que usa `renewlet_renovacion_mensual` con cuatro.

Parámetros, todos de tipo Text y **todos en modo Expression, no Fixed**:

```
{{ $('Webhook').first().json.body.service }}
{{ new Date($('Webhook').first().json.body.next_billing_date).toLocaleDateString('es-ES') }}
{{ $('Webhook').first().json.body.amount }}
{{ $('Webhook').first().json.body.reminder_window }}
```

La rama anual añade `price_note`, y su orden es servicio, fecha, importe, cambio
de precio, días:

```
{{ $('Webhook').first().json.body.price_note }}
```

Ninguna expresión calcula fechas ni días. Eso es deliberado: la resta la hace
renewlet una sola vez, cuando decide disparar el aviso.

`.first()` y no `.item`: `.item` depende del emparejamiento de items entre nodos
y se rompe en cuanto metes una rama. Aquí ya hay una rama, así que esto pasa de
recomendación a obligatorio.

Al elegir la plantilla en el nodo, cuidado con el idioma: las nuevas son
`renewlet_renovacion_mensual|es` y `renewlet_renovacion_anual|es`, mientras la
vieja es `renewlet_notificacion|es_ES`. Elegir la equivocada da un error de
plantilla no encontrada que no dice por qué.

## Orden de ejecución

1. Las dos plantillas en Meta. **Hecho, en revisión.**
2. El payload nuevo en renewlet, por un webhook nuevo, sin tocar el existente.
3. Solo entonces, el workflow nuevo en n8n.

Si haces el 3 antes del 2, los envíos fallan con un error de formato de
parámetro.

## Trampas del editor de plantillas de Meta

Todas verificadas en la práctica el 8 de septiembre, no sacadas de la
documentación.

- **El nombre y el idioma se fijan al crear y no se pueden editar nunca.** El
  cuerpo, las muestras y los botones sí, pasando por revisión otra vez.
- **La categoría solo se elige al crear.** Una plantilla ya aprobada no se puede
  recategorizar (las rechazadas o pausadas sí). Por eso creamos nuevas en lugar
  de editar la vieja de Marketing.
- **El campo del cuerpo autocompleta las llaves.** Si escribes `{{1}}` a mano te
  queda `{{1}}1}}`. Mete cada variable con el botón "Agregar variable".
- **El botón "Agregar variable" se come el espacio de delante.** Escribes `de ` y
  al insertar queda `de{{1}}`. Hay que volver a poner el espacio.
- **Una variable no puede ir al principio ni al final del cuerpo.** El editor
  muestra el error y deshabilita el envío. No está en la documentación, pero se
  aplica.
- **El campo de encabezado borra los emoji en silencio.** Los acepta al pegar y
  al escribir, y luego no están.
- **El desplegable de idioma se cierra si escribes.** Hay que elegir de la lista
  con el ratón. Y ojo con confundir "Spanish" (`es`) con "Spanish (SPA)"
  (`es_ES`), que son entradas distintas.

## Pendientes que no son de este cambio

- **Las fechas de facturación no avanzan de ciclo.** Es el bug que genera estos
  avisos de caducadas. Arreglarlo probablemente hace desaparecer la mitad de las
  notificaciones.
- **El planificador disparó dos veces** el 8 de septiembre, a las 07:23 y a las
  08:00, dos ejecuciones distintas del mismo workflow. Es el mismo agujero que
  resuelve el registro de `reminder_window`.
- **El número remitente es el de pruebas de Meta** (+1 555-202-6014). Solo
  escribe a destinatarios registrados a mano y tiene cupo diario. Para
  producción hace falta un número propio verificado.
- **`Renewlet → Google Sheets Sync` falló** el 8 de septiembre a las 00:00:26, el
  único error de once ejecuciones.
- **Comprobar la negrita en el primer mensaje real.** En la previsualización de
  Meta solo se ve en negrita la primera variable; la fecha y el importe salen
  normales aunque lleven asteriscos. Puede ser cosa de la previsualización o
  puede que ahí la negrita no funcione.
- **Líneas en blanco en los cuerpos.** Los dos quedaron como bloques de líneas
  seguidas. Se lee peor de lo necesario y es editable.
