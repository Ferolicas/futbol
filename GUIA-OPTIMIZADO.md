# ⚡ Sistema Optimizado - Guía de Uso

## 🎯 ¿Cómo Funciona?

Este sistema usa una estrategia **en 2 fases** para maximizar tus 100 requests gratuitos diarios:

### FASE 1: Lista Rápida (1-2 requests)
Carga TODOS los partidos del día mostrando solo:
- Equipos
- Hora
- Liga
- Estado (próximo/en vivo/finalizado)

### FASE 2: Análisis Detallado (5 requests por partido)
Solo cuando haces clic en "📊 Analizar", el sistema carga:
- Estadísticas completas de ambos equipos
- Historial H2H
- Lesionados
- Cuotas de apuestas

## 📊 Consumo de Requests

### Carga Inicial:
```
📋 Cargar Lista de Partidos = 1 request
→ Ves TODOS los partidos del día
```

### Por Cada Partido Analizado:
```
📊 Analizar Partido = 5 requests
→ Estadísticas de equipo local (1)
→ Estadísticas de equipo visitante (1)
→ Historial H2H (1)
→ Cuotas de apuestas (1)
→ Lesionados (1)
```

### Ejemplo Real:
```
Cargas la lista: 1 request
Analizas 10 partidos: 50 requests
Refrescas 5 en vivo: 5 requests
---
TOTAL: 56 requests → ¡Te quedan 44 para mañana!
```

## 🚀 Flujo de Trabajo Recomendado

### Por la Mañana:

```
1️⃣ Abre el sistema
2️⃣ Pega tu API key
3️⃣ Clic en "📋 Cargar Lista de Partidos"
4️⃣ Ves TODOS los partidos del día (1 request usado)
```

### Selección Inteligente:

```
5️⃣ Revisa la lista completa
6️⃣ Identifica partidos interesantes por:
   - Liga
   - Equipos
   - Hora
   - País
7️⃣ Usa filtros para organizar mejor
8️⃣ Oculta partidos que definitivamente no te interesan
```

### Análisis Profundo:

```
9️⃣ Haz clic en "📊 Analizar" SOLO en los 10-15 partidos que realmente te interesan
🔟 Cada análisis consume 5 requests
1️⃣1️⃣ Estudia las estadísticas completas
1️⃣2️⃣ Toma notas/capturas
```

### Durante el Día:

```
1️⃣3️⃣ Activa auto-refresh si hay partidos en vivo
1️⃣4️⃣ El sistema actualiza solo los marcadores (1 request por actualización)
1️⃣5️⃣ NO recargues la página completa
```

## 💡 Consejos para Maximizar Requests

### ✅ SÍ Hacer:

1. **Cargar lista una vez** → Ver todo antes de decidir
2. **Usar filtros** → Organizar sin gastar requests
3. **Ocultar partidos irrelevantes** → Limpiar vista
4. **Analizar selectivamente** → Solo lo que realmente importa
5. **Tomar capturas** → No necesitas recargar
6. **Mantener pestaña abierta** → No pierdes datos

### ❌ NO Hacer:

1. **Recargar página constantemente** → Pierdes datos y requests
2. **Analizar todos los partidos** → Gastas 100+ requests rápido
3. **Auto-refresh continuo** → Solo actívalo cuando necesites
4. **Cerrar navegador sin notas** → Tendrás que recargar todo

## 📈 Estrategias por Objetivo

### Para Apuestas Pre-Match:

```
Por la mañana:
→ Carga lista (1 request)
→ Filtra por tu país favorito
→ Analiza 5-10 partidos (25-50 requests)
→ Toma decisiones
→ Cierra sistema

Total: ~30-50 requests
```

### Para Seguimiento en Vivo:

```
Antes del primer partido:
→ Carga lista (1 request)
→ Analiza partidos que seguirás (15-25 requests)
→ Deja pestaña abierta
→ Activa auto-refresh
→ Sistema actualiza cada 60 seg (~10-20 requests extra)

Total: ~30-45 requests
```

### Para Investigación Completa:

```
Dividir en 2 sesiones:
Mañana:
→ Carga lista (1 request)
→ Analiza 8 partidos (40 requests)

Tarde:
→ NO recargar lista
→ Analiza 8 partidos más (40 requests)

Total: 81 requests → ¡Aún te quedan 19!
```

## 🎮 Funcionalidades del Sistema

### Contador de Requests
- **En el header** verás: "Requests usados hoy: X/100"
- Se resetea automáticamente cada 24 horas
- Te avisa cuando te quedan menos de 10

### Estadísticas en Tiempo Real
- **Partidos Hoy**: Total en la lista
- **En Vivo**: Cuántos están jugándose ahora
- **Analizados**: Cuántos has analizado en detalle
- **Ocultos**: Cuántos has ocultado

### Filtros Inteligentes
- **Por País**: Ver solo un país sin recargar
- **Por Estado**: Solo en vivo / Próximos / Finalizados
- Sin costo de requests

### Sistema de Ocultar
- Oculta partidos que no te interesan
- Se guardan en tu navegador
- Limpian la vista sin gastar requests

### Auto-Refresh Selectivo
- Actualiza solo marcadores de partidos en vivo
- Cada actualización = 1 request por partido en vivo
- Puedes activar/desactivar cuando quieras

## 📊 Información Mostrada

### En la Lista (sin analizar):
- Equipos con logos
- Liga y país
- Hora del partido
- Estado (próximo/en vivo/finalizado)
- Marcador si está en vivo

### Al Analizar (detalle completo):

#### Por Equipo:
✅ Posición en liga
✅ Últimos 5 resultados (W/D/L)
✅ Mejor forma destacada
✅ Partidos jugados
✅ Victorias/Empates/Derrotas
✅ Promedio de goles
✅ Goles a favor/en contra
✅ Penaltis fallados

#### Historial H2H:
✅ Últimos 3 como local
✅ Últimos 3 como visitante
✅ Fechas y resultados

#### Información Adicional:
✅ Jugadores lesionados/suspendidos (ambos equipos)
✅ Cuotas de apuestas (casa/empate/visitante)

## 🔧 Solución de Problemas

### "No se encontraron partidos"
**Causa**: No hay partidos ese día en las ligas configuradas
**Solución**: Prueba otra fecha

### "Error al cargar estadísticas"
**Causa**: Datos no disponibles para ese partido/liga
**Solución**: Normal en ligas menores, no todos tienen estadísticas completas

### Perdí los datos al cerrar el navegador
**Causa**: No se guardan automáticamente
**Solución**: 
- Toma capturas de pantalla
- Usa la función de impresión del navegador
- O mantén la pestaña abierta

### Excedí los 100 requests
**Causa**: Analizaste demasiados partidos
**Solución**: 
- Espera 24 horas
- Sé más selectivo mañana
- O contrata plan de pago

## 💰 Comparación de Planes

| Característica | Gratuito | Basic ($15/mes) |
|----------------|----------|-----------------|
| Requests/día | 100 | 500 |
| Cargas de lista | 10-20 | 100+ |
| Partidos analizables | 15-20 | 80-100 |
| Auto-refresh | Limitado | Ilimitado |

## 🎯 Casos de Uso Reales

### Caso 1: Apostador Casual
```
Objetivo: Analizar 5 partidos de La Liga
Consumo:
- Carga lista: 1
- Analiza 5: 25
- Total: 26 requests
```

### Caso 2: Seguidor de Múltiples Ligas
```
Objetivo: Ver partidos de España, Inglaterra, Alemania
Consumo:
- Carga lista: 1
- Filtra por cada país (sin costo)
- Analiza 3 por liga = 9 partidos: 45
- Total: 46 requests
```

### Caso 3: Trader en Vivo
```
Objetivo: Seguir 10 partidos en vivo
Consumo:
- Carga lista: 1
- Analiza 10 pre-match: 50
- Auto-refresh cada 60s por 2 horas: ~20
- Total: 71 requests
```

## ⚖️ Disclaimer

Este sistema es una herramienta de análisis, no garantiza resultados en apuestas. Usa responsablemente.

## 🆘 Soporte

Si necesitas ayuda:
1. Lee esta guía completa
2. Revisa el contador de requests
3. Verifica tu API key
4. Consulta la consola del navegador (F12) para errores

---

**¡Analiza inteligentemente y maximiza tus requests!** ⚡📊
