# -*- coding: utf-8 -*-
"""Enclosure for the Hornet alarm: LilyGO T-SIM7600E-L1C with its 18650 cell, the ADXL345 and
the two antennas.

Builds the box ("Κουτί") and the lid ("Καπάκι") in a new Fusion design, around LilyGO's own
3D model of the board (cad/lilygo/T-SIM7600-Board-3D.stp, from
github.com/Xinyuan-LilyGO/LilyGo-Modem-Series, folder dimensions/esp32; not kept in git).

- The board lies upside down: the cell faces up, right under the lid, so it can be swapped
  after taking off the lid; the parts face the floor.
- Nothing else sits on the board, so the box is as thin as the board with its cell allows.
- The 4G antenna strip stands along the end wall past the antenna sockets, from its fed end,
  and turns up the switch-side wall; the ADXL345 lies in the opposite corner, as far from it
  and from the modem as the box allows (when the modem transmits it can fool the sensor).
- The GPS antenna sits on a pedestal near its socket, facing up just under the lid.
- Beside the USB-C sockets there is room for a straight USB-C plug, and a lane along the
  outer wall takes its cable to the gland hole.
- Two openings, both printed closed by a thin skin on the inside: the gland hole (since version
  9 the skin is 0.45 mm, one line of a 0.4 mm nozzle, so a thumb or the back of a pen pushes it
  out), and (since version 8) a 6 mm hole in the switch-side wall for the switch drive. The
  charge LED, facing down, shows only with the lid off.
- The SIM card goes in from above without taking the lid off (since version 9). A SIM
  extension's far end (its socket at the tip of a rigid end) stands upright on a sled in a guide
  in the switch-side bay past the paddle, its mouth just under the lid. An opening in the lid
  over it is closed by a TPU plug pressed in by hand (since version 10; version 9 had a cap with
  two screws), made like the cable's grommet: a plate with a ring squeezed against the lid, a
  skirt a little wider than the opening, a 45 degree lip that catches under the lid, and a tab to
  pull it out. To swap the card: switch off, pull the plug out, take the card out with tweezers,
  or lift the sled 10 mm by a bent paperclip in the hole across its ear (the cable has slack for
  that) and change it by hand; push the sled down, press the plug back in.
- The blue LED (LilyGO's LED_G1) also faces the floor, next to the ESP32 and 6.75 mm from the
  switch-side edge. A light guide in clear PETG takes its light: a foot under the board, 0.5 mm
  under the LED, where a 45 degree face sends the light along the foot, and another one up a riser
  beside the board to just under the plug, which in natural (translucent) TPU then glows blue.
- The switch drive turns the board on and off with the lid on. A shaft goes through that hole;
  inside, its paddle takes the switch's knob in a slot, and outside a small lever turns it. A
  TPU washer, squeezed between the lever and the wall by the lever's screw, seals the hole.
  The slot is wider than the knob and its travel, so the board drops into it with the lever
  upright, and the lever can shake a little without moving the switch. Turned to one side, the
  slot's wall pushes the knob past the middle of its travel and the switch snaps over; there a
  corner of the bar along the paddle's bottom meets the floor, so the lever cannot force the
  knob against its end. The shaft goes in from the inside before the board.
- A drill guide makes that hole in a box printed before version 8: it stands on the table
  between the strap tabs, against the switch-side wall, and guides a 3 mm pilot bit.

Run it in Fusion: Utilities > Add-Ins > Scripts and Add-Ins > + > this file > Run.
It writes the parts to print, in mm: cad/kouti.stl (the box, as it prints), cad/kapaki.stl
(the lid, upside down, as it prints), cad/lastixo.stl (the seal for the groove, in TPU:
a rigid plastic would not seal), and for the switch drive cad/diakoptis-axonas.stl (the shaft,
standing on its paddle), cad/diakoptis-lavi.stl (the lever, on its outer face),
cad/diakoptis-rodela.stl (the washer, in TPU) and cad/odigos-trypaniou.stl (the drill guide),
and for the SIM card cad/sim-syrtaraki.stl (the sled, on its back), cad/sim-tapa.stl (the plug,
TPU, upside down on its plate) and cad/fotagogos.stl (the light guide, clear PETG, on its side).
Pictures go to cad/out/.

All sizes are in mm. Box frame: LilyGO's model turned 180 degrees about its long axis (x and z
change sign). PCB: x 0 (USB-C side) to 32.89 (switch side), y 0 (antenna sockets) to 110.54
(ESP32), z -1.6 (parts side, down) to 0 (cell side, up).
"""
import math
import os
import traceback

import adsk.core
import adsk.fusion

VERSION = '10'

# ---- The board, measured on LilyGO's 3D model, in the box frame -----------------------
PCB = (0.0, 32.89, 0.0, 110.54)               # x0, x1, y0, y1; z -1.6 .. 0
PCB_DOWN = -1.6                               # the parts side
HOLES = [(30.3, 2.29), (2.59, 2.29), (2.59, 107.87), (30.3, 107.87)]   # 2.0 mm, for M2
KNOB = (34.66, 32.71, 57.57, 59.07, -4.07, -2.57) # switch knob: x tip, x root, y0, y1, z0, z1
SWITCH = (29.21, 32.71, 54.96, 63.34, -5.05, -1.6) # the switch's body: x0, x1, y0, y1, z0, z1
USB_X = -0.95                                 # the USB-C sockets stick out on that side
USB_Z = -3.18                                 # their middle height
TTL_Y = 61.0                                  # middle of the socket marked TTL (USB is at 51)
JST_LOW = -7.2                                # SOLAR input, the part that hangs lowest
CELL = (16.11, 9.92, 9.3, 23.5, 92.5)         # 18650: axis x, axis z, radius, y0, y1 (estimate)
CELL_TOP = 19.42                              # a fat 18.8 mm cell pressed into the holder
GPS_SOCKET = (3.09, 44.3)                     # u.FL marked GPS, next to the USB-C sockets
MAIN_SOCKET = (24.95, 1.43)                   # u.FL for the 4G antenna (AUX is at 7.9, 1.59)
SIM7600 = (1.44, 31.44, 8.86, 38.86)          # the modem: x0, x1, y0, y1
WIRE_HOLES = (78.1, 98.4)                     # y of the ADXL345 wires (39 ... 3V3), at x = 1.2

# ---- The box -------------------------------------------------------------------------
CLR = 0.5                 # gap around the board
WALL = 2.6
FLOOR = 1.6
LID = 1.8
R_OUT = 4.0               # outer corner radius
ANT_BAY = 9.0             # switch side: room between the knob and the 4G antenna strip
SIDE_BAY = 34.0           # USB-C side: a USB-C plug, the GPS antenna, the ADXL345, a cable lane
PLUG = (25.0, 16.0, 8.0)  # room for a straight USB-C plug in the TTL socket: length, width, height
CABLE = 4.0               # the plug's cable: lane along the outer wall, then to the gland
END_ANT = 8.0             # room past the antenna sockets (y < 0)
END_GLAND = 12.0          # room past the ESP32 end, for the cable gland
Z_FLOOR_IN = JST_LOW - 1.0
Z_LID_IN = CELL_TOP + 0.5 # a thin foam pad on the cell keeps it in its holder
BOSS_D = 7.0              # lid screw bosses; the lid reaches down to them with plugs,
BOSS_TOP = Z_LID_IN - 3.0 # so that flat-head M3 screws sit flush with the lid
BOSS_PILOT, BOSS_DEPTH = 2.5, 10.0
PLUG_D = 5.8                              # the lid's plugs stay clear of the walls
LID_HOLE, LID_CSK = 3.4, 6.4              # M3 countersunk screws, 90 degree head
STANDOFF_D, STANDOFF_PILOT, STANDOFF_DEPTH = 5.0, 1.7, 6.0   # M2 screws from the cell side
GLAND_D, GLAND_Z = 12.5, 4.0              # PG7 / M12 cable gland, centre height
KNOCKOUT = 0.6                            # skin left on the inside of the switch hole (drilled out)
GLAND_SKIN = 0.45                         # the gland hole's skin: one line, pushed out by hand
STRAP_Y = (25.0, 95.0)                    # strap tab centres
STRAP_TAB = (30.0, 7.0, 3.0)              # length along y, reach, thickness
STRAP_SLOT = (3.2, 22.0)                  # width, length (fits a 20 mm strap or cable ties)
GROOVE = (0.7, 1.9, 2.0)                  # seal groove on top of the walls: inset from, to, depth
TONGUE = (0.95, 1.65, 1.2)                # lid tongue in it, leaving 0.8 mm for a seal cord
GASKET = (0.1, 1.0)                       # TPU seal in the groove: side gap, height (squeezed 0.2)
ROUND_TOP, ROUND_BOTTOM = 1.5, 1.0        # rounded outer edges of the lid top and the box bottom

# ---- Parts that only show where things go (not printed) ------------------------------
GPS = (28.0, 7.0, 85.0)                   # active GPS antenna: side, height, centre y
GY291 = (15.4, 20.3, 3.7)                 # ADXL345 board on foam tape: x, y, height
STRIP = (125.0, 25.0, 0.3)                # 4G antenna strip "Full Band LTE": length, width

XB0, XB1 = USB_X - CLR, KNOB[0] + CLR     # the board's own room: USB-C side .. switch side
X_IN0, X_IN1 = XB0 - SIDE_BAY, XB1 + ANT_BAY
Y_IN0, Y_IN1 = PCB[2] - END_ANT, PCB[3] + END_GLAND
X_OUT0, X_OUT1 = X_IN0 - WALL, X_IN1 + WALL
Y_OUT0, Y_OUT1 = Y_IN0 - WALL, Y_IN1 + WALL
Z_BOT, Z_TOP = Z_FLOOR_IN - FLOOR, Z_LID_IN + LID
GPS_Z = Z_LID_IN - 0.5 - GPS[1]           # top of the GPS pedestal: its face just under the lid
# bosses stand 1.5 mm off the walls the antenna strip runs along (switch side, antenna end)
BOSS_OFF = BOSS_D / 2 + 1.5
BOSSES = [(X_IN0 + 3.0, Y_IN0 + BOSS_OFF), (XB1 + BOSS_D / 2 + 0.5, Y_IN0 + BOSS_OFF),
          (XB1 + BOSS_D / 2 + 0.5, Y_IN1 - 3.0), (X_IN0 + 3.0, Y_IN1 - 3.0)]
GY291_BOX = (BOSSES[3][0] + BOSS_D / 2 + 0.5, BOSSES[3][0] + BOSS_D / 2 + 0.5 + GY291[1],
             Y_IN1 - 0.5 - GY291[0], Y_IN1 - 0.5)        # x0, x1, y0, y1, on the floor, lying across
STRIP_FEED_X = X_IN0 + 2.0                               # fed end of the strip
STRIP_X1 = X_IN1 - 1.5                                   # it bends round the corner here
STRIP_END = STRIP_X1 - STRIP_FEED_X                      # length along the end wall
STRIP_SIDE = STRIP[0] - STRIP_END - 2.4                  # the rest, up the switch-side wall
STRIP_TOP = Y_IN0 + 1.5 + STRIP_SIDE                     # where it ends on that wall

# ---- Switch drive through the switch-side wall (since version 8) -----------------------
SW_Y = (SWITCH[2] + SWITCH[3]) / 2    # middle of the knob's travel: the model shows the knob at
                                      # one end, 0.83 mm from it, so it travels about 1.7 mm
SW_ARM = 4.5                          # the drive's axis, above the knob's middle
SW_Z = (KNOB[4] + KNOB[5]) / 2 + SW_ARM
SW_SLOT = 4.0                         # slot for the knob: its width, its travel and some play
SW_PUSH = 0.6                         # at the stop the knob is this far past the middle of its
                                      # travel; the switch snaps the rest of the way by itself
SW_FACE = PCB[1] + 0.5                # the paddle's face, clear of the board's edge
SW_TINE, SW_BACK = 2.0, 1.5           # the paddle: slot depth, back
SW_BAR = (9.0, 3.0, 0.5)              # stop bar along the paddle's bottom: half length, height,
                                      # corner radius; a corner meets the floor at the stop
SW_SHOULDER = 9.0                     # bears on the inside of the wall
SW_SHAFT, SW_HOLE = 5.6, 6.0          # through the wall, in a 6 mm hole
SW_FLAT = 2.3                         # flat on the shaft's end that keys the lever, from the axis
SW_FLAT_X = X_OUT1 + 1.45             # where that flat begins, past the squeezed washer
SW_WASHER = (5.2, 14.0, 1.5, 1.2)    # TPU washer: bore, outside, thickness, squeezed to
SW_END = X_OUT1 + 1.0 + 4.5           # the shaft's end: the lever's bore bottoms on it when the
                                      # washer is squeezed to 1.0 mm, so it cannot be crushed
LEVER = (16.0, 7.1, 8.0, 17.0)        # hub diameter and thickness, lever width and reach
M3_PILOT, M3_HOLE, M3_HEAD = 2.5, 3.4, 6.4   # one more flat-head M3 x 10, like the lid's
GUIDE = (8.0, 3.2)                    # drill guide: thickness, hole for a 3 mm pilot bit

# ---- SIM card through the lid, and the blue LED's light (since version 9) ---------------
# The SIM extension (micro to micro, 148 mm FPC): its far end, judged from the listing photo, is
# a rigid end with an open socket at its tip; the card slides in along it and stays by friction.
SIM_END = (24.0, 15.5, 3.0)           # the rigid end: length (it stands upright), width, thickness
SIM_CARD = (15.0, 12.0, 0.76)         # micro SIM: length, width, thickness
SIM_OUT = 2.5                         # how far a card may stand out of the socket's mouth
SIM_MOUTH = Z_TOP - SIM_OUT - 0.3     # the mouth: such a card stays just under the plug
SIM_LIFT = 10.0                       # the sled rises this much to swap the card by hand
SLED_X = (36.2, 41.0)                 # the sled across the bay: its front, its back
SLED_Y = 79.8                         # its -y side, past the paddle's sweep (y 70 at most)
SLED_RAIL, SLED_BACK = 1.2, 1.2       # its rails and back plate; the end sits between two rails
SLED_POCKET = SIM_END[1] + 0.6
SLED_EAR = (4.8, 7.0)                 # a block past the pocket, at the top, with a hole across it
                                      # for a paperclip hook that lifts the sled: width, height
SLED_Y1 = SLED_Y + 3 * SLED_RAIL + SLED_POCKET + SLED_EAR[0]
SLED_Z = (SIM_MOUTH - SIM_END[0] - 0.6, Z_TOP - 0.3)
CHANNEL_WALL = 1.2                    # the sled's guide, part of the box
LIGHT_LED = (26.14, 76.65)            # the blue LED (LED_G1, 0603), parts side, facing the floor
LIGHT_W = 2.5                         # the light guide: width
LIGHT_FOOT = (-7.0, -2.6)             # its foot under the board, 0.5 mm under the LED's face and R8
                                      # (z -2.10 on LilyGO's model); the SIM cable passes under it
LIGHT_X0 = 25.8                       # its end under the LED, 0.6 mm past the diode D6 (x up to
                                      # 25.21, hanging to z -3.40)
LIGHT_RISER = (PCB[1] + 0.5, PCB[1] + 0.5 + LIGHT_FOOT[1] - LIGHT_FOOT[0])   # beside the board
LIGHT_Y = LIGHT_LED[1] - LIGHT_W / 2
# the opening in the lid, 1.5 mm clear of the sled and the riser, for the plug's skirt
OPENING = (LIGHT_RISER[0] - 1.5, SLED_X[1] + 1.5, LIGHT_Y - 1.5, SLED_Y1 + 1.5)
OPENING_R = 2.0                       # its corner radius
# The TPU plug that closes it, pressed in by hand like the cable's grommet (since version 10, the
# owner asked for something simpler than screws)
TAPA_FIT = 0.15                       # its skirt is this much wider than the opening, each side
TAPA_SKIRT = 1.2                      # skirt thickness
TAPA_LIP = (1.25, 1.1, 0.4)           # 45 degree lip under the lid: reach past the opening, depth at
                                      # which it is widest, how much narrower than the opening its tip is
TAPA_PLATE = (2.4, 1.6)               # its plate on the lid: reach past the opening, thickness
TAPA_BEAD = (0.8, 0.5, 0.35)          # raised ring under the plate: from (past the opening), width,
                                      # height (squeezed flat against the lid)
TAPA_TAB = (8.0, 5.0, 1.2)            # pull tab past the plate's switch-side edge: width, reach, thickness
CHANNEL_TOP = Z_LID_IN - TAPA_LIP[1] - TAPA_LIP[0] - TAPA_LIP[2] - 0.5    # the guide stays under the lip

NEW = adsk.fusion.FeatureOperations.NewBodyFeatureOperation
JOIN = adsk.fusion.FeatureOperations.JoinFeatureOperation
CUT = adsk.fusion.FeatureOperations.CutFeatureOperation


def V(mm):
    return adsk.core.ValueInput.createByReal(mm / 10.0)


def P(x, y, z=0.0):
    return adsk.core.Point3D.create(x / 10.0, y / 10.0, z / 10.0)


class Part:
    """Features of one component that holds a single body."""

    def __init__(self, comp):
        self.comp = comp

    @property
    def body(self):
        return self.comp.bRepBodies.item(0) if self.comp.bRepBodies.count else None

    def plane(self, axis, value):
        c = self.comp
        base = {'x': c.yZConstructionPlane, 'y': c.xZConstructionPlane, 'z': c.xYConstructionPlane}[axis]
        if abs(value) < 1e-9:
            return base
        for sign in (1, -1):    # an offset follows the plane's normal, which may point either way
            pi = c.constructionPlanes.createInput()
            pi.setByOffset(base, V(sign * value))
            pl = c.constructionPlanes.add(pi)
            o = pl.geometry.origin
            if abs({'x': o.x, 'y': o.y, 'z': o.z}[axis] * 10 - value) < 1e-6:
                pl.isLightBulbOn = False
                return pl
            pl.deleteMe()
        raise RuntimeError('no plane at %s = %s' % (axis, value))

    def sketch(self, axis, value):
        sk = self.comp.sketches.add(self.plane(axis, value))
        sk.isVisible = False
        return sk

    def extrude(self, profiles, dist, op, symmetric=False):
        """Extrude by dist towards the positive end of the axis the sketch plane is across."""
        ext = self.comp.features.extrudeFeatures
        coll = adsk.core.ObjectCollection.create()
        for p in profiles:
            coll.add(p)
        inp = ext.createInput(coll, op)
        if symmetric:
            inp.setSymmetricExtent(V(dist), True)
        elif facing(profiles[0].parentSketch) > 0:
            inp.setDistanceExtent(False, V(dist))
        else:
            inp.setOneSideExtent(adsk.fusion.DistanceExtentDefinition.create(V(dist)),
                                 adsk.fusion.ExtentDirections.NegativeExtentDirection)
        if op != NEW and self.body is not None:
            inp.participantBodies = [self.body]
        return ext.add(inp)

    def box(self, x0, x1, y0, y1, z0, z1, op, r=0.0):
        s = self.sketch('z', z0)
        rrect(s, x0, y0, x1, y1, r, z0)
        return self.extrude(profiles(s), z1 - z0, op)

    def box_x(self, x0, x1, y0, y1, z0, z1, op, r=0.0):
        """The same, drawn across x: corners rounded as seen along x."""
        s = self.sketch('x', x0)
        rrect3(s, (x0, y0, z0), (x0, y1, z1), r)
        return self.extrude(profiles(s), x1 - x0, op)

    def cyl_x(self, x0, x1, y, z, d, op):
        s = self.sketch('x', x0)
        circle(s, x0, y, z, d)
        return self.extrude(profiles(s), x1 - x0, op)

    def holes(self, points, d, z0, z1, op):
        s = self.sketch('z', z0)
        for x, y in points:
            circle(s, x, y, z0, d)
        return self.extrude(profiles(s), z1 - z0, op)


def facing(sk):
    """+1 if the sketch's normal points along a positive model axis, -1 if a negative one."""
    n = sk.xDirection.crossProduct(sk.yDirection)
    c = max((n.x, n.y, n.z), key=abs)
    return 1 if c > 0 else -1


def profiles(sk):
    return [sk.profiles.item(i) for i in range(sk.profiles.count)]


def sp(sk, x, y, z):
    return sk.modelToSketchSpace(P(x, y, z))


def rrect(sk, x0, y0, x1, y1, r, z):
    """Rectangle with rounded corners on a plane at height z."""
    rrect3(sk, (x0, y0, z), (x1, y1, z), r)


def rrect3(sk, p0, p1, r):
    """Rectangle with rounded corners, from two opposite corners on the sketch's plane."""
    lines = sk.sketchCurves.sketchLines.addTwoPointRectangle(sp(sk, *p0), sp(sk, *p1))
    if r <= 0:
        return
    L = [lines.item(i) for i in range(lines.count)]
    corners = []
    for i in range(4):
        for j in range(i + 1, 4):
            for a in (L[i].startSketchPoint, L[i].endSketchPoint):
                for b in (L[j].startSketchPoint, L[j].endSketchPoint):
                    if a.geometry.isEqualTo(b.geometry):
                        corners.append((L[i], L[j], a.geometry.copy()))
    for li, lj, pt in corners:
        sk.sketchCurves.sketchArcs.addFillet(li, pt, lj, pt, r / 10.0)


def circle(sk, x, y, z, d):
    sk.sketchCurves.sketchCircles.addByCenterRadius(sp(sk, x, y, z), d / 20.0)


def new_comp(root, name):
    occ = root.occurrences.addNewComponent(adsk.core.Matrix3D.create())
    occ.component.name = name
    return occ


def ring(b, z0, inset_a, inset_b, height, op):
    """A band following the outline, between two insets from the outer faces."""
    s = b.sketch('z', z0)
    for a in (inset_a, inset_b):
        rrect(s, X_OUT0 + a, Y_OUT0 + a, X_OUT1 - a, Y_OUT1 - a, R_OUT - a, z0)
    band = min(profiles(s), key=lambda p: p.areaProperties().area)
    return b.extrude([band], height, op)


def build_base(comp):
    b = Part(comp)
    b.box(X_OUT0, X_OUT1, Y_OUT0, Y_OUT1, Z_BOT, Z_LID_IN, NEW, R_OUT)
    b.body.name = 'Κουτί'

    # strap tabs on both long sides, at floor level; they reach into the box so that their
    # inner rounded corners end up inside the wall and the floor, leaving a clean outline
    length, reach, thick = STRAP_TAB
    s = b.sketch('z', Z_BOT)
    for yc in STRAP_Y:
        y0, y1 = yc - length / 2, yc + length / 2
        rrect(s, X_OUT0 - reach, y0, X_IN0 + 1.0, y1, 2.0, Z_BOT)
        rrect(s, X_IN1 - 1.0, y0, X_OUT1 + reach, y1, 2.0, Z_BOT)
    b.extrude(profiles(s), thick, JOIN)

    # the inside
    b.box(X_IN0, X_IN1, Y_IN0, Y_IN1, Z_FLOOR_IN, Z_LID_IN + 1, CUT, R_OUT - WALL)

    # pedestal for the GPS antenna, beside the board on the USB-C side, clear of the cable lane
    side, _, yc = GPS
    b.box(XB0 - side - 1.0, XB0, yc - side / 2 - 1.0, yc + side / 2 + 1.0, Z_FLOOR_IN, GPS_Z, JOIN)

    # standoffs under the board's four holes, up to its parts side
    b.holes(HOLES, STANDOFF_D, Z_FLOOR_IN, PCB_DOWN, JOIN)
    b.holes(HOLES, STANDOFF_PILOT, PCB_DOWN - STANDOFF_DEPTH, PCB_DOWN + 0.5, CUT)

    # lid screw bosses
    b.holes(BOSSES, BOSS_D, Z_FLOOR_IN, BOSS_TOP, JOIN)
    b.holes(BOSSES, BOSS_PILOT, BOSS_TOP - BOSS_DEPTH, BOSS_TOP + 0.5, CUT)

    # strap slots
    w, l = STRAP_SLOT
    s = b.sketch('z', Z_BOT - 0.5)
    for yc in STRAP_Y:
        for xc in (X_OUT0 - reach / 2, X_OUT1 + reach / 2):
            rrect(s, xc - w / 2, yc - l / 2, xc + w / 2, yc + l / 2, w / 2 - 0.05, Z_BOT - 0.5)
    b.extrude(profiles(s), thick + 1, CUT)

    # cable gland hole in the end wall past the ESP32, cut from outside and closed by a thin
    # skin on the inside: break it out with a screwdriver (or drill it) when the cable goes in
    s = b.sketch('y', Y_OUT1)
    circle(s, (XB0 + XB1) / 2, Y_OUT1, GLAND_Z, GLAND_D)
    b.extrude(profiles(s), 2 * (WALL - GLAND_SKIN), CUT, symmetric=True)

    # hole for the switch drive's shaft in the switch-side wall, closed the same way: drill
    # the skin out with a 6 mm bit when the drive goes in
    s = b.sketch('x', X_OUT1)
    circle(s, X_OUT1, SW_Y, SW_Z, SW_HOLE)
    b.extrude(profiles(s), 2 * (WALL - KNOCKOUT), CUT, symmetric=True)

    # guide for the SIM sled in the switch-side bay past the paddle: a back wall against the outer
    # wall, two fins with lips in front that keep the sled upright, and ledges it stands on; the
    # front stays open between the lips for the SIM cable
    fy0, fy1 = SLED_Y - 0.2, SLED_Y1 + 0.2
    top = CHANNEL_TOP
    front = XB1 + 0.5
    b.box(SLED_X[1] + 0.2, X_IN1 + 0.5, fy0 - CHANNEL_WALL, fy1 + CHANNEL_WALL, Z_FLOOR_IN, top, JOIN)
    b.box(front, SLED_X[1] + 0.3, fy0 - CHANNEL_WALL, fy0, Z_FLOOR_IN, top, JOIN)
    b.box(front, SLED_X[1] + 0.3, fy1, fy1 + CHANNEL_WALL, Z_FLOOR_IN, top, JOIN)
    b.box(front, SLED_X[0] - 0.2, fy0, fy0 + 0.8, Z_FLOOR_IN, top, JOIN)
    b.box(front, SLED_X[0] - 0.2, fy1 - 0.8, fy1, Z_FLOOR_IN, top, JOIN)
    b.box(SLED_X[0] - 0.3, SLED_X[1] + 0.3, fy0, SLED_Y + SLED_RAIL + 0.2, Z_FLOOR_IN, SLED_Z[0], JOIN)
    b.box(SLED_X[0] - 0.3, SLED_X[1] + 0.3, SLED_Y1 - SLED_RAIL - 0.2, fy1, Z_FLOOR_IN, SLED_Z[0], JOIN)
    # a fin that keeps the light guide's riser upright, across from the guide's first fin
    b.box(LIGHT_RISER[0] + 0.3, LIGHT_RISER[1] - 0.3, LIGHT_Y - 1.2, LIGHT_Y - 0.4, Z_FLOOR_IN, 8.0, JOIN)

    # seal groove along the top of the walls
    a, c, depth = GROOVE
    ring(b, Z_LID_IN - depth, a, c, depth + 0.5, CUT)

    round_edges(comp, b.body, Z_BOT, ROUND_BOTTOM)
    return b.body


def build_gasket(comp):
    """The seal: a TPU ring lying in the groove, which the lid's tongue squeezes by 0.2 mm."""
    b = Part(comp)
    a, c, depth = GROOVE
    side, high = GASKET
    ring(b, Z_LID_IN - depth, a + side, c - side, high, NEW)
    b.body.name = 'Λάστιχο'
    return b.body


def build_lid(comp):
    b = Part(comp)
    b.box(X_OUT0, X_OUT1, Y_OUT0, Y_OUT1, Z_LID_IN, Z_TOP, NEW, R_OUT)
    b.body.name = 'Καπάκι'

    # tongue that presses into the seal on top of the walls
    a, c, h = TONGUE
    ring(b, Z_LID_IN - h, a, c, h, JOIN)

    # plugs down to the bosses, screw holes and countersinks
    b.holes(BOSSES, PLUG_D, BOSS_TOP, Z_LID_IN, JOIN)
    b.holes(BOSSES, LID_HOLE, BOSS_TOP - 0.5, Z_TOP + 0.5, CUT)
    countersink(b, BOSSES, LID_CSK, LID_HOLE)

    # the opening over the SIM sled and the light guide's riser, closed by the TPU plug
    x0, x1, y0, y1 = OPENING
    b.box(x0, x1, y0, y1, Z_LID_IN - 1.0, Z_TOP + 1.0, CUT, OPENING_R)

    round_edges(comp, b.body, Z_TOP, ROUND_TOP)
    return b.body


def switch_stop():
    """The drive's stop angle (radians either way from upright), and how far below the axis the
    stop bar's bottom must be for a corner of it to meet the floor at that angle.

    Turned by an angle th, the slot's wall meets the knob's lower corner, SW_ARM plus half the
    knob's height below the axis, and holds the knob's middle at least
    w/2 + (arm sin th - SW_SLOT/2) / cos th past the middle of its travel; the stop is where
    that comes to SW_PUSH."""
    w, h = KNOB[3] - KNOB[2], KNOB[5] - KNOB[4]
    arm, past = SW_ARM + h / 2, SW_PUSH - w / 2
    th = math.asin(SW_SLOT / 2 / math.hypot(arm, past)) - math.atan2(-past, arm)
    a, _, rc = SW_BAR
    reach = SW_Z - Z_FLOOR_IN
    bottom = (reach - rc - (a - rc) * math.sin(th)) / math.cos(th) + rc
    return th, bottom


def build_switch_shaft(comp):
    """The drive's shaft, in place with the lever upright. It prints standing on the paddle."""
    b = Part(comp)
    _, bottom = switch_stop()
    a, high, rc = SW_BAR
    back = SW_FACE + SW_TINE + SW_BACK
    r = SW_SHOULDER / 2
    # the paddle: the stop bar along its bottom, a web up to the axis, a disc round it
    b.box_x(SW_FACE, back, SW_Y - a, SW_Y + a, SW_Z - bottom, SW_Z - bottom + high, NEW, rc)
    b.body.name = 'Άξονας διακόπτη'
    b.box_x(SW_FACE, back, SW_Y - r, SW_Y + r, SW_Z - bottom + rc, SW_Z, JOIN)
    b.cyl_x(SW_FACE, back, SW_Y, SW_Z, SW_SHOULDER, JOIN)
    # the slot for the knob, through the paddle's whole height: the knob drops in from above
    b.box_x(SW_FACE - 0.5, SW_FACE + SW_TINE, SW_Y - SW_SLOT / 2, SW_Y + SW_SLOT / 2,
            SW_Z - bottom - 1.0, SW_Z + r + 1.0, CUT)
    # shoulder up to the wall, then the shaft through it
    b.cyl_x(back, X_IN1, SW_Y, SW_Z, SW_SHOULDER, JOIN)
    b.cyl_x(X_IN1, SW_END, SW_Y, SW_Z, SW_SHAFT, JOIN)
    # the flat that keys the lever (on the shaft's underside), and the pilot for its screw
    b.box_x(SW_FLAT_X, SW_END + 0.5, SW_Y - 4.0, SW_Y + 4.0, SW_Z - 4.0, SW_Z - SW_FLAT, CUT)
    b.cyl_x(SW_END - 8.5, SW_END + 0.5, SW_Y, SW_Z, M3_PILOT, CUT)
    return b.body


def build_switch_handle(comp):
    """The lever, upright, on the washer squeezed to SW_WASHER[3]. It prints on its outer face."""
    b = Part(comp)
    face = X_OUT1 + SW_WASHER[3]
    hub_d, hub_t, width, reach = LEVER
    b.cyl_x(face - 0.9, face + hub_t, SW_Y, SW_Z, hub_d, NEW)
    b.body.name = 'Λαβή διακόπτη'
    b.box_x(face + 1.6, face + hub_t, SW_Y - width / 2, SW_Y + width / 2, SW_Z, SW_Z + reach, JOIN,
            width / 2 - 0.1)
    # a recess for the washer, leaving a skirt round it that keeps the spray off
    b.cyl_x(face - 1.5, face, SW_Y, SW_Z, SW_WASHER[1] + 0.6, CUT)
    # the bore for the shaft, round for its first millimetre, then keyed by the flat
    b.cyl_x(face - 1.0, face + 4.5, SW_Y, SW_Z, SW_SHAFT + 0.3, CUT)
    b.box_x(face + 1.0, face + 4.5, SW_Y - 3.2, SW_Y + 3.2, SW_Z - 3.2, SW_Z - SW_FLAT - 0.15, JOIN)
    # the screw into the shaft's end, its head flush with the lever
    b.cyl_x(face + 4.0, face + hub_t + 0.5, SW_Y, SW_Z, M3_HOLE, CUT)
    countersink_x(b, face + hub_t, SW_Y, SW_Z, M3_HEAD, M3_HOLE)
    return b.body


def build_switch_washer(comp):
    """The TPU washer between the lever and the wall, as printed (before it is squeezed)."""
    b = Part(comp)
    bore, outside, thick, _ = SW_WASHER
    s = b.sketch('x', X_OUT1)
    circle(s, X_OUT1, SW_Y, SW_Z, outside)
    circle(s, X_OUT1, SW_Y, SW_Z, bore)
    ring = max(profiles(s), key=lambda p: p.areaProperties().area)
    b.extrude([ring], thick, NEW)
    b.body.name = 'Ροδέλα'
    return b.body


def build_drill_guide(comp):
    """Stands on the table between the strap tabs, pressed against the switch-side wall."""
    b = Part(comp)
    thick, hole = GUIDE
    y0 = STRAP_Y[0] + STRAP_TAB[0] / 2 + 0.15
    y1 = STRAP_Y[1] - STRAP_TAB[0] / 2 - 0.15
    b.box_x(X_OUT1, X_OUT1 + thick, y0, y1, Z_BOT, SW_Z + 6.0, NEW, 1.0)
    b.body.name = 'Οδηγός τρυπανιού'
    b.cyl_x(X_OUT1 - 0.5, X_OUT1 + thick + 0.5, SW_Y, SW_Z, hole, CUT)
    return b.body


def build_sim_sled(comp):
    """The sled that holds the SIM extension's far end upright, its socket's mouth at the top, on
    double-sided tape against the back plate. It stands on the guide's ledges, and prints lying on
    its back plate."""
    b = Part(comp)
    x0, x1 = SLED_X
    z0, z1 = SLED_Z
    back = x1 - SLED_BACK
    b.box(back, x1, SLED_Y, SLED_Y1, z0, z1, NEW)
    b.body.name = 'Συρταράκι SIM'
    rail1 = SLED_Y + SLED_RAIL + SLED_POCKET
    for y in (SLED_Y, rail1, SLED_Y1 - SLED_RAIL):
        b.box(x0, back, y, y + SLED_RAIL, z0, z1, JOIN)
    b.box(x0, back, rail1 + SLED_RAIL, SLED_Y1 - SLED_RAIL, z1 - SLED_EAR[1], z1, JOIN)
    # a hole across the ear, 2 mm under its top: a bent paperclip hooks in it to lift the sled
    b.cyl_x(x0 - 0.5, x1 + 0.5, (rail1 + SLED_Y1) / 2, z1 - 2.0, 2.2, CUT)
    return b.body


def opening_outline(sk, grow, z):
    """The lid's opening, grown by grow mm all round (shrunk if negative), on a sketch at height z."""
    x0, x1, y0, y1 = OPENING
    rrect(sk, x0 - grow, y0 - grow, x1 + grow, y1 + grow, OPENING_R + grow, z)


def ring_profile(sk):
    """The band between two nested outlines on a sketch: the smaller of its two profiles."""
    return min(profiles(sk), key=lambda p: p.areaProperties().area)


def build_sim_plug(comp):
    """The TPU plug in the lid's opening, in place as pressed in, made like the cable's grommet: a
    plate on the lid with a raised ring under it that is squeezed flat, a skirt a little wider than
    the opening, and a lip that widens at 45 degrees under the lid, catches there, and narrows again
    to a tip smaller than the opening, to start it in. A tab past the switch-side edge pulls it
    out. It prints upside down, on its plate; in natural (translucent) TPU the blue light shows."""
    b = Part(comp)
    reach, thick = TAPA_PLATE
    s = b.sketch('z', Z_TOP)
    opening_outline(s, reach, Z_TOP)
    b.extrude(profiles(s), thick, NEW)
    b.body.name = 'Τάπα SIM'
    w, out, t = TAPA_TAB
    yc = (OPENING[2] + OPENING[3]) / 2
    b.box(OPENING[1] + reach - 2.0, OPENING[1] + reach + out, yc - w / 2, yc + w / 2, Z_TOP, Z_TOP + t, JOIN, 1.0)
    a, bw, bh = TAPA_BEAD
    s = b.sketch('z', Z_TOP - bh)
    opening_outline(s, a, Z_TOP - bh)
    opening_outline(s, a + bw, Z_TOP - bh)
    b.extrude([ring_profile(s)], bh, JOIN)
    s = b.sketch('z', Z_LID_IN)
    opening_outline(s, TAPA_FIT, Z_LID_IN)
    opening_outline(s, TAPA_FIT - TAPA_SKIRT, Z_LID_IN)
    b.extrude([ring_profile(s)], Z_TOP - Z_LID_IN, JOIN)
    # the lip, lofted through three outlines, then hollowed like the skirt
    lip, deep, tip = TAPA_LIP
    zs = (Z_LID_IN, Z_LID_IN - deep, Z_LID_IN - deep - lip - tip)
    lofts = b.comp.features.loftFeatures
    li = lofts.createInput(JOIN)
    for z, g in zip(zs, (TAPA_FIT, lip, -tip)):
        s = b.sketch('z', z)
        opening_outline(s, g, z)
        li.loftSections.add(profiles(s)[0])
    li.isSolid = True
    try:
        li.participantBodies = [b.body]
    except Exception:
        pass
    lofts.add(li)
    s = b.sketch('z', zs[2] - 0.5)
    opening_outline(s, TAPA_FIT - TAPA_SKIRT, zs[2] - 0.5)
    b.extrude(profiles(s), Z_TOP - zs[2] + 0.5, CUT)
    return b.body


def build_light_guide(comp):
    """Clear PETG from under the blue LED to just under the plug. The LED shines down into the
    foot's top; a 45 degree face under it sends the light along the foot, another one at the
    riser's foot sends it up. A short leg stands on the floor. It prints lying on its side."""
    b = Part(comp)
    zb, zt = LIGHT_FOOT
    r0, r1 = LIGHT_RISER
    top = Z_TOP - 0.2
    pts = [(LIGHT_X0, zt), (r0, zt), (r0, top), (r1, top), (r1, zt), (r0, zb),
           (r0, Z_FLOOR_IN), (r0 - 0.6, Z_FLOOR_IN), (r0 - 0.6, zb), (LIGHT_X0 + zt - zb, zb)]
    s = b.sketch('y', LIGHT_Y)
    lines = s.sketchCurves.sketchLines
    first = prev = None
    for i in range(len(pts)):
        (xa, za), (xb, zb2) = pts[i], pts[(i + 1) % len(pts)]
        start = prev.endSketchPoint if prev else sp(s, xa, LIGHT_Y, za)
        end = first.startSketchPoint if i == len(pts) - 1 else sp(s, xb, LIGHT_Y, zb2)
        prev = lines.addByTwoPoints(start, end)
        first = first or prev
    b.extrude(profiles(s), LIGHT_W, NEW)
    b.body.name = 'Φωταγωγός'
    return b.body


def countersink_x(b, x_top, y, z, d_top, d_hole):
    """90 degree countersink into a face at x = x_top that faces +x; checks the cone narrows
    inwards."""
    depth = (d_top - d_hole) / 2
    for angle in ('-45 deg', '45 deg'):
        s = b.sketch('x', x_top)
        circle(s, x_top, y, z, d_top)
        ext = b.comp.features.extrudeFeatures
        inp = ext.createInput(profiles(s)[0], CUT)
        inward = (adsk.fusion.ExtentDirections.NegativeExtentDirection if facing(s) > 0
                  else adsk.fusion.ExtentDirections.PositiveExtentDirection)
        inp.setOneSideExtent(adsk.fusion.DistanceExtentDefinition.create(V(depth)), inward,
                             adsk.core.ValueInput.createByString(angle))
        inp.participantBodies = [b.body]
        try:
            f = ext.add(inp)
        except Exception:
            s.deleteMe()
            continue
        cones = [fc for fc in f.faces if fc.geometry.surfaceType == adsk.core.SurfaceTypes.ConeSurfaceType]
        if cones:
            bb = cones[0].boundingBox
            if (bb.maxPoint.y - bb.minPoint.y) * 10 <= d_top + 0.05:
                return True
        f.deleteMe()
        s.deleteMe()
    print('Countersink failed: the lever has a plain screw hole')
    return False


def turn(design, occ, angle):
    """Turn an occurrence about the switch drive's axis (radians; 0 puts it back)."""
    m = adsk.core.Matrix3D.create()
    if angle:
        m.setToRotation(angle, adsk.core.Vector3D.create(1, 0, 0), P(0, SW_Y, SW_Z))
    place(design, occ, m)


def shift(design, occ, dx=0.0, dz=0.0):
    """Move an occurrence by dx, dz mm (0, 0 puts it back)."""
    m = adsk.core.Matrix3D.create()
    m.translation = adsk.core.Vector3D.create(dx / 10.0, 0, dz / 10.0)
    place(design, occ, m)


def place(design, occ, m):
    occ.transform2 = m
    if design.snapshots.hasPendingSnapshot:
        design.snapshots.add()


def overlap(design, a, b):
    """Volume (mm3) where two bodies overlap."""
    coll = adsk.core.ObjectCollection.create()
    coll.add(a)
    coll.add(b)
    ii = design.createInterferenceInput(coll)
    ii.areCoincidentFacesIncluded = False
    res = design.analyzeInterference(ii)
    return sum(res.item(i).interferenceBody.volume for i in range(res.count)) * 1000


def countersink(b, points, d_top, d_hole, z_top=Z_TOP):
    """90 degree countersinks from a top face at z_top; checks the cone narrows downwards."""
    depth = (d_top - d_hole) / 2
    for angle in ('-45 deg', '45 deg'):
        s = b.sketch('z', z_top)
        for x, y in points:
            circle(s, x, y, z_top, d_top)
        ext = b.comp.features.extrudeFeatures
        coll = adsk.core.ObjectCollection.create()
        for p in profiles(s):
            coll.add(p)
        inp = ext.createInput(coll, CUT)
        inp.setOneSideExtent(adsk.fusion.DistanceExtentDefinition.create(V(depth)),
                             adsk.fusion.ExtentDirections.NegativeExtentDirection,
                             adsk.core.ValueInput.createByString(angle))
        inp.participantBodies = [b.body]
        f = ext.add(inp)
        cones = [fc for fc in f.faces if fc.geometry.surfaceType == adsk.core.SurfaceTypes.ConeSurfaceType]
        if cones:
            bb = cones[0].boundingBox
            if (bb.maxPoint.x - bb.minPoint.x) * 10 <= d_top + 0.05:
                return
        f.deleteMe()
        s.deleteMe()
    print('Countersink failed: %s has plain holes' % b.body.name)


def round_edges(comp, body, z, r):
    """Round the outer edges of the flat face at height z (the bottom, or the lid top)."""
    for f in body.faces:
        bb = f.boundingBox
        if f.geometry.surfaceType != adsk.core.SurfaceTypes.PlaneSurfaceType:
            continue
        if abs(bb.minPoint.z * 10 - z) > 1e-3 or abs(bb.maxPoint.z * 10 - z) > 1e-3:
            continue
        for loop in f.loops:
            if not loop.isOuter:
                continue
            edges = adsk.core.ObjectCollection.create()
            for e in loop.edges:
                edges.add(e)
            fi = comp.features.filletFeatures.createInput()
            fi.edgeSetInputs.addConstantRadiusEdgeSet(edges, V(r), True)
            try:
                comp.features.filletFeatures.add(fi)
            except Exception as e:
                print('Could not round the edges at z = %s: %s' % (z, e))
            return
    print('No flat face at z = %s to round' % z)


def block(root, name, x0, x1, y0, y1, z0, z1):
    occ = new_comp(root, name)
    Part(occ.component).box(x0, x1, y0, y1, z0, z1, NEW)
    return occ


def import_board(app, root, step):
    """LilyGO's model, turned upside down about its long axis (into the box frame)."""
    im = app.importManager
    im.importToTarget(im.createSTEPImportOptions(step), root)
    occ = root.occurrences.item(root.occurrences.count - 1)
    comp = occ.component
    comp.name = 'Πλακέτα LilyGO (αναφορά)'
    turn = adsk.core.Matrix3D.create()
    turn.setToRotation(math.pi, adsk.core.Vector3D.create(0, 1, 0), adsk.core.Point3D.create(0, 0, 0))
    bodies = adsk.core.ObjectCollection.create()
    for i in range(comp.bRepBodies.count):
        bodies.add(comp.bRepBodies.item(i))
    moves = comp.features.moveFeatures
    try:
        mi = moves.createInput2(bodies)
        mi.defineAsFreeMove(turn)
    except AttributeError:
        mi = moves.createInput(bodies, turn)
    moves.add(mi)
    return occ


def build_refs(app, root, step):
    refs = []
    if os.path.exists(step):
        refs.append(import_board(app, root, step))
    else:
        print('No board model at %s: the box is drawn without it.' % step)

    occ = new_comp(root, 'Μπαταρία 18650 (αναφορά)')
    b = Part(occ.component)
    x, z, r, y0, y1 = CELL
    ym = (y0 + y1) / 2
    s = b.sketch('y', ym)
    circle(s, x, ym, z, 2 * r)
    b.extrude(profiles(s), y1 - y0, NEW, symmetric=True)
    refs.append(occ)

    side, height, yc = GPS
    refs.append(block(root, 'Κεραία GPS (αναφορά)', XB0 - side - 0.5, XB0 - 0.5,
                      yc - side / 2, yc + side / 2, GPS_Z, GPS_Z + height))

    # a USB-C plug in the TTL socket, and its cable: along the outer wall, then across the
    # end past the ESP32 (above the ADXL345) and into the gland
    length, width, high = PLUG
    refs.append(block(root, 'Φις USB-C (αναφορά)', USB_X - length, USB_X,
                      TTL_Y - width / 2, TTL_Y + width / 2, USB_Z - high / 2, USB_Z + high / 2))
    lane_x = X_IN0 + 0.5
    cross_y = Y_IN1 - 3.0 - BOSS_D / 2 - 1.0 - CABLE      # just short of the corner boss
    gland_x = (XB0 + XB1) / 2
    occ = new_comp(root, 'Καλώδιο του φις (αναφορά)')
    b = Part(occ.component)
    b.box(lane_x, lane_x + CABLE, TTL_Y, cross_y + CABLE, USB_Z, USB_Z + CABLE, NEW)
    b.box(lane_x, gland_x + CABLE / 2, cross_y, cross_y + CABLE, USB_Z, USB_Z + CABLE, JOIN)
    b.box(gland_x - CABLE / 2, gland_x + CABLE / 2, cross_y, Y_IN1, USB_Z, GLAND_Z + CABLE / 2, JOIN)
    refs.append(occ)
    gx0, gx1, gy0, gy1 = GY291_BOX
    refs.append(block(root, 'ADXL345 (αναφορά)', gx0, gx1, gy0, gy1, Z_FLOOR_IN, Z_FLOOR_IN + GY291[2]))
    _, width, thick = STRIP
    z0 = Z_FLOOR_IN + 1.5
    refs.append(block(root, 'Κεραία 4G στην άκρη των κεραιών (αναφορά)', STRIP_FEED_X, STRIP_X1,
                      Y_IN0, Y_IN0 + thick, z0, z0 + width))
    refs.append(block(root, 'Κεραία 4G στον πλαϊνό τοίχο (αναφορά)', X_IN1 - thick, X_IN1,
                      Y_IN0 + 1.5, STRIP_TOP, z0, z0 + width))
    # the SIM extension's far end on its sled, and a card standing in its socket
    length, width, thick = SIM_END
    yc = SLED_Y + SLED_RAIL + SLED_POCKET / 2
    back = SLED_X[1] - SLED_BACK
    refs.append(block(root, 'Άκρη προέκτασης SIM (αναφορά)', back - thick, back,
                      yc - width / 2, yc + width / 2, SIM_MOUTH - length, SIM_MOUTH))
    cl, cw, ct = SIM_CARD
    xc = back - thick / 2
    refs.append(block(root, 'Κάρτα SIM (αναφορά)', xc - ct / 2, xc + ct / 2, yc - cw / 2, yc + cw / 2,
                      SIM_MOUTH + SIM_OUT - cl, SIM_MOUTH + SIM_OUT))
    return refs


def distances():
    """How far the ADXL345 is from the 4G antenna strip, its fed end and the modem (mm)."""
    gx0, gx1, gy0, gy1 = GY291_BOX
    to_side = ((X_IN1 - gx1) ** 2 + max(0.0, gy0 - STRIP_TOP) ** 2) ** 0.5
    to_end = gy0 - Y_IN0
    feed = (STRIP_FEED_X + 10.0, Y_IN0)            # the cable is soldered ~1 cm from that end
    dx = max(0.0, gx0 - feed[0], feed[0] - gx1)
    to_feed = (dx ** 2 + (gy0 - feed[1]) ** 2) ** 0.5
    to_modem = (max(0.0, SIM7600[0] - gx1) ** 2 + (gy0 - SIM7600[3]) ** 2) ** 0.5
    return min(to_side, to_end), to_feed, to_modem


def export_stl(design, occ, path, lay=None):
    """One printable part as a binary STL in mm. lay = (angle, axis) turns it the way it
    prints, with a move feature that is deleted again after the export."""
    comp = occ.component
    move = None
    if lay:
        angle, axis = lay
        m = adsk.core.Matrix3D.create()
        m.setToRotation(angle, adsk.core.Vector3D.create(*axis), adsk.core.Point3D.create(0, 0, 0))
        bodies = adsk.core.ObjectCollection.create()
        bodies.add(comp.bRepBodies.item(0))
        moves = comp.features.moveFeatures
        try:
            mi = moves.createInput2(bodies)
            mi.defineAsFreeMove(m)
        except AttributeError:
            mi = moves.createInput(bodies, m)
        move = moves.add(mi)
    try:
        em = design.exportManager
        opts = em.createSTLExportOptions(comp.bRepBodies.item(0), path)
        opts.isBinaryFormat = True
        opts.meshRefinement = adsk.fusion.MeshRefinementSettings.MeshRefinementHigh
        if not em.execute(opts):
            raise RuntimeError('STL export failed: ' + path)
    finally:
        if move is not None:
            move.deleteMe()


def clashes(design, parts, refs):
    bodies = adsk.core.ObjectCollection.create()
    for occ in parts + refs:
        bodies.add(occ.bRepBodies.item(0))
    ii = design.createInterferenceInput(bodies)
    ii.areCoincidentFacesIncluded = False
    res = design.analyzeInterference(ii)
    names = set(o.component.name for o in parts)
    found = []
    for i in range(res.count):
        r = res.item(i)
        a, b = r.entityOne.parentComponent.name, r.entityTwo.parentComponent.name
        if a in names or b in names:
            found.append('%s <> %s: %.1f mm3' % (a, b, r.interferenceBody.volume * 1000))
    return found


def paint(app, design, body, *words):
    """Give a body the first library appearance whose name has all the words."""
    for lib_name in ('Fusion Appearance Library', 'Fusion 360 Appearance Library'):
        lib = app.materialLibraries.itemByName(lib_name)
        if not lib:
            continue
        for i in range(lib.appearances.count):
            ap = lib.appearances.item(i)
            if all(w.lower() in ap.name.lower() for w in words):
                local = design.appearances.itemByName(ap.name) or design.appearances.addByCopy(ap, ap.name)
                body.appearance = local
                return ap.name
    return None


def snap(app, path, eye, target, up=(0, 0, 1)):
    vp = app.activeViewport
    cam = vp.camera
    cam.isSmoothTransition = False
    cam.cameraType = adsk.core.CameraTypes.OrthographicCameraType
    cam.eye = P(*eye)
    cam.target = P(*target)
    cam.upVector = adsk.core.Vector3D.create(*up)
    vp.camera = cam
    adsk.doEvents()
    vp.fit()
    adsk.doEvents()
    vp.saveAsImageFile(path, 1600, 1000)


def closeup(app, path, eye, target, extent, up=(0, 0, 1)):
    """A picture of a part of the design, extent mm across."""
    vp = app.activeViewport
    cam = vp.camera
    cam.isSmoothTransition = False
    cam.cameraType = adsk.core.CameraTypes.OrthographicCameraType
    cam.eye = P(*eye)
    cam.target = P(*target)
    cam.upVector = adsk.core.Vector3D.create(*up)
    cam.isFitView = False
    cam.viewExtents = extent / 10.0
    vp.camera = cam
    adsk.doEvents()
    vp.saveAsImageFile(path, 1600, 1000)


def show(occs, on):
    for occ in occs:
        occ.isLightBulbOn = on


def build():
    app = adsk.core.Application.get()
    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.join(here, 'out')
    os.makedirs(out, exist_ok=True)
    before = app.activeDocument      # put back in front at the end, unless it is one of ours

    # close the unsaved designs this script made before
    for d in list(app.documents):
        try:
            des = adsk.fusion.Design.cast(d.products.itemByProductType('DesignProductType'))
            if des and des.attributes.itemByName('hornet', 'kouti') and not d.isSaved:
                d.close(False)
        except Exception:
            pass

    app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
    design = adsk.fusion.Design.cast(app.activeProduct)
    design.designType = adsk.fusion.DesignTypes.ParametricDesignType
    design.fusionUnitsManager.distanceDisplayUnits = adsk.fusion.DistanceUnits.MillimeterDistanceUnits
    design.attributes.add('hornet', 'kouti', VERSION)
    root = design.rootComponent

    base = new_comp(root, 'Κουτί')
    lid = new_comp(root, 'Καπάκι')
    build_base(base.component)
    build_lid(lid.component)
    gasket = new_comp(root, 'Λάστιχο (TPU)')
    build_gasket(gasket.component)
    shaft = new_comp(root, 'Άξονας διακόπτη')
    build_switch_shaft(shaft.component)
    handle = new_comp(root, 'Λαβή διακόπτη')
    build_switch_handle(handle.component)
    washer = new_comp(root, 'Ροδέλα διακόπτη (TPU)')
    build_switch_washer(washer.component)
    guide = new_comp(root, 'Οδηγός τρυπανιού')
    build_drill_guide(guide.component)
    drive = [shaft, handle, washer]
    sled = new_comp(root, 'Συρταράκι SIM')
    build_sim_sled(sled.component)
    tapa = new_comp(root, 'Τάπα SIM (TPU)')
    build_sim_plug(tapa.component)
    light = new_comp(root, 'Φωταγωγός (διάφανο PETG)')
    build_light_guide(light.component)
    refs = build_refs(app, root, os.path.join(here, 'lilygo', 'T-SIM7600-Board-3D.stp'))

    print('Paint:', paint(app, design, base.bRepBodies.item(0), 'plastic', 'matte', 'blue'),
          paint(app, design, lid.bRepBodies.item(0), 'plastic', 'translucent'),
          paint(app, design, gasket.bRepBodies.item(0), 'rubber') or
          paint(app, design, gasket.bRepBodies.item(0), 'plastic', 'matte', 'red'))
    for occ in (shaft, handle):
        body = occ.bRepBodies.item(0)
        print('Paint:', paint(app, design, body, 'plastic', 'matte', 'grey') or
              paint(app, design, body, 'plastic', 'matte', 'gray') or
              paint(app, design, body, 'plastic', 'matte', 'white'))
    print('Paint:', paint(app, design, washer.bRepBodies.item(0), 'rubber') or
          paint(app, design, washer.bRepBodies.item(0), 'plastic', 'matte', 'red'),
          paint(app, design, guide.bRepBodies.item(0), 'plastic', 'matte', 'green'))
    print('Paint:', paint(app, design, sled.bRepBodies.item(0), 'plastic', 'matte', 'grey') or
          paint(app, design, sled.bRepBodies.item(0), 'plastic', 'matte', 'gray'),
          paint(app, design, tapa.bRepBodies.item(0), 'plastic', 'translucent', 'clear') or
          paint(app, design, tapa.bRepBodies.item(0), 'plastic', 'translucent'),
          paint(app, design, light.bRepBodies.item(0), 'plastic', 'translucent', 'blue') or
          paint(app, design, light.bRepBodies.item(0), 'plastic', 'translucent'))
    # the parts that only show where things go, in a colour of their own (not printed)
    for occ in refs:
        if occ.component.name.startswith('Πλακέτα'):
            continue
        body = occ.bRepBodies.item(0)
        for words in (('plastic', 'translucent', 'orange'), ('plastic', 'translucent', 'yellow'),
                      ('plastic', 'orange'), ('orange',)):
            got = paint(app, design, body, *words)
            if got:
                break
    print('References painted:', got)

    print('Box outside: %.1f x %.1f mm, %.1f mm tall with the lid' % (
        X_OUT1 - X_OUT0, Y_OUT1 - Y_OUT0, Z_TOP - Z_BOT))
    print('With the strap tabs: %.1f mm wide' % (X_OUT1 - X_OUT0 + 2 * STRAP_TAB[1]))
    for occ in (base, lid):
        v = occ.bRepBodies.item(0).volume
        print('%s: %.1f cm3, about %.0f g of PETG when solid' % (occ.component.name, v, v * 1.27))
    if refs and refs[0].component.name.startswith('Πλακέτα'):
        bb = refs[0].bRepBodies.item(0).boundingBox
        print('Board after turning: z %.2f .. %.2f, x %.2f .. %.2f' % (
            bb.minPoint.z * 10, bb.maxPoint.z * 10, bb.minPoint.x * 10, bb.maxPoint.x * 10))
    found = clashes(design, [base, lid], refs)
    print('Clashes:', found if found else 'none')
    a, c, _ = GROOVE
    side, high = GASKET
    print('Gasket: %.1f mm wide in the %.1f mm groove, %.1f mm high; squeezed by the lid:' % (
        c - a - 2 * side, c - a, high), clashes(design, [gasket], [base, lid]) or 'nothing')
    print('ADXL345 to the 4G strip %.0f mm, to its fed end %.0f mm, to the modem %.0f mm' % distances())

    # the switch drive: where its hole is, how far it turns, and what it meets
    th, bottom = switch_stop()
    for occ in drive + [guide]:
        bb = occ.bRepBodies.item(0).boundingBox
        print('%s: x %.2f .. %.2f, y %.2f .. %.2f, z %.2f .. %.2f, %.2f cm3' % (
            occ.component.name, bb.minPoint.x * 10, bb.maxPoint.x * 10, bb.minPoint.y * 10,
            bb.maxPoint.y * 10, bb.minPoint.z * 10, bb.maxPoint.z * 10, occ.bRepBodies.item(0).volume))
    print('Switch hole: centre %.2f mm from the antenna end (outside), %.2f mm above the bottom, '
          '%.2f mm past the strap tab' % (SW_Y - Y_OUT0, SW_Z - Z_BOT,
                                          SW_Y - (STRAP_Y[0] + STRAP_TAB[0] / 2)))
    knob = (KNOB[2] + KNOB[3]) / 2
    print('Lever stops %.1f degrees either way of upright (its tip moves %.1f mm); the knob is '
          'then %.2f mm past the middle of its travel; stop bar %.2f mm under the axis' % (
              math.degrees(th), LEVER[3] * math.sin(th), SW_PUSH, bottom))
    print('With the lever upright the knob has %.2f mm of play each side (at either end)' % (
        SW_SLOT / 2 - abs(SW_Y - knob) - (KNOB[3] - KNOB[2]) / 2))
    print('Drive at rest:', clashes(design, drive, [base, lid] + refs) or 'touches nothing')
    print('Drill guide:', clashes(design, [guide], [base] + refs) or 'touches nothing')
    floor = max((f for f in base.bRepBodies.item(0).faces
                 if f.geometry.surfaceType == adsk.core.SurfaceTypes.PlaneSurfaceType
                 and abs(f.boundingBox.minPoint.z * 10 - Z_FLOOR_IN) < 1e-3
                 and abs(f.boundingBox.maxPoint.z * 10 - Z_FLOOR_IN) < 1e-3), key=lambda f: f.area)
    for sign in (1, -1):
        gaps = []
        for deg in (-1.0, 0.0):
            for occ in drive:
                turn(design, occ, sign * (th + math.radians(deg)))
            gaps.append(app.measureManager.measureMinimumDistance(
                shaft.bRepBodies.item(0), floor).value * 10)
        print('Turned %+.1f degrees: the stop bar %.2f mm off the floor, %.2f mm a degree before;' % (
            math.degrees(sign * th), gaps[1], gaps[0]),
            clashes(design, [shaft, handle], [base, lid] + refs) or 'touches nothing')
    for occ in drive:
        turn(design, occ, 0)
    board = refs[0] if refs and refs[0].component.name.startswith('Πλακέτα') else None
    if board:
        worst = 0.0
        for dz in (0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12):
            shift(design, board, dz=dz)
            worst = max(worst, overlap(design, shaft.bRepBodies.item(0), board.bRepBodies.item(0)),
                        overlap(design, light.bRepBodies.item(0), board.bRepBodies.item(0)))
        shift(design, board)
        print('Board lowered onto its standoffs with the lever upright and the light guide in:',
              'meets nothing' if worst < 0.01 else 'meets something (%.2f mm3)' % worst)

    # the SIM card through the lid, and the light guide
    sim_refs = [o for o in refs if 'SIM' in o.component.name]
    for occ in (sled, tapa, light):
        bb = occ.bRepBodies.item(0).boundingBox
        print('%s: x %.2f .. %.2f, y %.2f .. %.2f, z %.2f .. %.2f, %.2f cm3' % (
            occ.component.name, bb.minPoint.x * 10, bb.maxPoint.x * 10, bb.minPoint.y * 10,
            bb.maxPoint.y * 10, bb.minPoint.z * 10, bb.maxPoint.z * 10, occ.bRepBodies.item(0).volume))
    print('Opening in the lid: x %.2f .. %.2f, y %.2f .. %.2f; the plug stands %.1f mm over the lid, its '
          'lip reaches %.2f mm past the opening under it; the guide ends at z %.2f' % (
              OPENING + (TAPA_PLATE[1], TAPA_LIP[0], CHANNEL_TOP)))
    print('SIM socket: %.1f mm short of the ESP32 end of the board, %.1f mm past the end of the 4G strip' % (
        PCB[3] - (SLED_Y + SLED_RAIL + SLED_POCKET), SLED_Y + SLED_RAIL - STRIP_TOP))
    print('Sled and light guide:', clashes(design, [sled, light], [base, lid, tapa] + refs + drive)
          or 'touch nothing')
    print('Plug, squeezed into the lid (skirt and ring):', clashes(design, [tapa], [lid]) or 'nothing',
          '; against the rest:', clashes(design, [tapa], [base, sled, light] + refs) or 'nothing')
    for name, part in (('sled', sled), ('light guide', light)):
        print('Plug to the %s: %.2f mm' % (name, app.measureManager.measureMinimumDistance(
            tapa.bRepBodies.item(0), part.bRepBodies.item(0)).value * 10))
    if board:
        print('Light guide: %.2f mm from the board at the closest; the foot\'s top %.2f mm under the '
              'parts side' % (app.measureManager.measureMinimumDistance(
                  light.bRepBodies.item(0), board.bRepBodies.item(0)).value * 10, PCB_DOWN - LIGHT_FOOT[1]))
    for sign in (1, -1):
        for occ in drive:
            turn(design, occ, sign * th)
        print('Lever at %+.1f degrees, the shaft against the box (the hole\'s skin counts) and the SIM parts:'
              % math.degrees(sign * th), clashes(design, [shaft], [sled, light, base]) or 'nothing')
    for occ in drive:
        turn(design, occ, 0)

    cx, cy, cz = (X_OUT0 + X_OUT1) / 2, (Y_OUT0 + Y_OUT1) / 2, (Z_BOT + Z_TOP) / 2
    sx = (SW_FACE + SW_END) / 2
    inside = [lid, gasket] + [o for o in refs if not o.component.name.startswith('Πλακέτα')]
    show([guide], False)
    # the drive's parts apart, in the order they go in
    show([base] + inside + ([board] if board else []), False)
    shift(design, washer, dx=8.0)
    shift(design, handle, dx=16.0)
    closeup(app, os.path.join(out, 'diakoptis-0-kommatia.png'), (sx - 80, SW_Y - 110, SW_Z + 60),
            (sx + 8, SW_Y, SW_Z + 2), 62)
    shift(design, washer)
    shift(design, handle)
    if board:
        show([board], True)
    knob = (SW_FACE + 1.0, SW_Y, (KNOB[4] + KNOB[5]) / 2)
    closeup(app, os.path.join(out, 'diakoptis-1-kato.png'),
            (knob[0] - 45, knob[1] - 60, knob[2] - 100), knob, 34)
    show([base], True)
    closeup(app, os.path.join(out, 'diakoptis-2-pano.png'), (sx - 70, SW_Y - 90, SW_Z + 150),
            (sx, SW_Y, SW_Z), 70)
    show(inside, True)
    closeup(app, os.path.join(out, 'diakoptis-3-exo.png'), (X_OUT1 + 160, SW_Y - 110, SW_Z + 90),
            (X_OUT1 + 3, SW_Y, SW_Z + 3), 75)
    show(drive, False)
    show([guide], True)
    closeup(app, os.path.join(out, 'diakoptis-4-odigos.png'), (X_OUT1 + 160, SW_Y - 130, SW_Z + 100),
            (X_OUT1 + 4, SW_Y, SW_Z - 2), 100)
    show([guide], False)
    show(drive, True)

    # the SIM card's way in, the sled lifted to swap it, and the light guide under the board
    ccx, ccy = (OPENING[0] + OPENING[1]) / 2, (OPENING[2] + OPENING[3]) / 2
    everything = [base, lid, gasket, sled, light] + drive + refs
    show(everything, False)
    closeup(app, os.path.join(out, 'sim-0-tapa.png'), (ccx + 45, ccy - 75, Z_TOP - 55),
            (ccx, ccy, Z_TOP - 1), 62)
    show(everything, True)
    closeup(app, os.path.join(out, 'sim-1-tapa-sto-kapaki.png'), (ccx + 70, ccy - 110, Z_TOP + 110),
            (ccx, ccy, Z_TOP + 1), 75)
    show([tapa], False)
    for occ in [sled] + sim_refs:
        shift(design, occ, dz=SIM_LIFT)
    print('Sled lifted %.0f mm with the plug out: the socket\'s mouth %.1f mm over the lid;' % (
        SIM_LIFT, SIM_MOUTH + SIM_LIFT - Z_TOP), clashes(design, [sled], [base, lid] + refs) or 'touches nothing')
    closeup(app, os.path.join(out, 'sim-2-allagi.png'), (ccx + 70, ccy - 100, Z_TOP + 80),
            (ccx + 1, ccy, Z_TOP + 4), 60)
    for occ in [sled] + sim_refs:
        shift(design, occ)
    show([lid], False)
    closeup(app, os.path.join(out, 'sim-3-mesa.png'), (ccx + 70, ccy - 90, 70), (ccx, ccy - 4, 6), 70)
    show([base], False)
    closeup(app, os.path.join(out, 'fotagogos.png'), (LIGHT_LED[0] - 30, LIGHT_LED[1] - 70, -60),
            (31.0, LIGHT_LED[1], -3.0), 40)
    show([base, lid, tapa], True)

    target = (cx, cy, cz)
    iso = (cx + 250, cy - 300, cz + 220)
    show([lid, tapa], False)
    snap(app, os.path.join(out, 'v%s-2-anoixto.png' % VERSION), iso, target)
    snap(app, os.path.join(out, 'v%s-3-apo-pano.png' % VERSION), (cx, cy, cz + 500), target, (0, 1, 0))
    show([lid, tapa], True)
    snap(app, os.path.join(out, 'v%s-4-plai-diakoptis.png' % VERSION), (cx + 500, cy, cz), target)
    snap(app, os.path.join(out, 'v%s-5-akri-kalodio.png' % VERSION), (cx, cy + 500, cz), target)
    snap(app, os.path.join(out, 'v%s-6-apo-kato.png' % VERSION), (cx - 200, cy - 250, cz - 300), target)
    snap(app, os.path.join(out, 'v%s-1-kleisto.png' % VERSION), iso, target)
    print('Pictures in', out)

    y_axis, x_axis = (0, 1, 0), (1, 0, 0)
    export_stl(design, base, os.path.join(here, 'kouti.stl'))
    export_stl(design, lid, os.path.join(here, 'kapaki.stl'), (math.pi, x_axis))
    export_stl(design, gasket, os.path.join(here, 'lastixo.stl'))
    export_stl(design, shaft, os.path.join(here, 'diakoptis-axonas.stl'), (-math.pi / 2, y_axis))
    export_stl(design, handle, os.path.join(here, 'diakoptis-lavi.stl'), (math.pi / 2, y_axis))
    export_stl(design, washer, os.path.join(here, 'diakoptis-rodela.stl'), (math.pi / 2, y_axis))
    export_stl(design, guide, os.path.join(here, 'odigos-trypaniou.stl'), (-math.pi / 2, y_axis))
    export_stl(design, sled, os.path.join(here, 'sim-syrtaraki.stl'), (math.pi / 2, y_axis))
    export_stl(design, tapa, os.path.join(here, 'sim-tapa.stl'), (math.pi, x_axis))
    export_stl(design, light, os.path.join(here, 'fotagogos.stl'), (math.pi / 2, x_axis))
    print('STL files written')

    try:
        if before is not None and before.isValid:
            before.activate()
    except Exception:
        pass


def run(context):
    try:
        build()
    except Exception:
        adsk.core.Application.get().userInterface.messageBox(traceback.format_exc())


if __name__ == '__main__':
    build()
