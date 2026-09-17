"""Wire protocol for LogMessage frames.

Mirrors ``spec/Proto.hpp``. A serialized frame is::

    +-----------+----------------+--------------------+
    | timestamp | flags          | payload            |
    | 8 B       | 2 B            | 0..N B             |
    +-----------+----------------+--------------------+

All multi-byte fields are little-endian.

``flags`` packs three enum *indices* (not the bit-flag values), starting from
the least significant bit:

    bits 0..3   payload type index   (MESSAGE_PAYLOAD_TYPE_ENCODED_BITS = 4)
    bits 4..6   source subsystem idx (SOURCE_SUBSYSTEM_ENCODED_BITS = 3)
    bits 7..9   message type index   (MESSAGE_TYPE_ENCODED_BITS = 3)

The spec constrains the field widths by ``ceil(log2(number_of_entries))``, so
what travels on the wire is the ordinal of each enum entry; the enum constants
themselves are ``1 << ordinal`` bit flags used for filtering.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from enum import IntEnum
from typing import Any

# --- Field widths, from Proto.hpp -------------------------------------------------

MESSAGE_PAYLOAD_TYPE_ENCODED_BITS = 4
SOURCE_SUBSYSTEM_ENCODED_BITS = 3
MESSAGE_TYPE_ENCODED_BITS = 3

HEADER_SIZE = 10  # 8 B timestamp + 2 B flags

_PAYLOAD_SHIFT = 0
_SRC_SHIFT = MESSAGE_PAYLOAD_TYPE_ENCODED_BITS
_TYPE_SHIFT = _SRC_SHIFT + SOURCE_SUBSYSTEM_ENCODED_BITS

_PAYLOAD_MASK = (1 << MESSAGE_PAYLOAD_TYPE_ENCODED_BITS) - 1
_SRC_MASK = (1 << SOURCE_SUBSYSTEM_ENCODED_BITS) - 1
_TYPE_MASK = (1 << MESSAGE_TYPE_ENCODED_BITS) - 1


class ProtocolError(ValueError):
    """Raised when a frame cannot be decoded."""


# --- Enums ---------------------------------------------------------------------
#
# Values match the C bit flags; ``index`` is what goes on the wire.


class MessagePayloadType(IntEnum):
    P_NONE = 1 << 0
    P_BOOL = 1 << 1
    P_FLOAT = 1 << 2
    P_DOUBLE = 1 << 3
    P_INT = 1 << 4
    P_LONG = 1 << 5
    P_FVEC2 = 1 << 6
    P_FVEC3 = 1 << 7
    P_STRING = 1 << 8

    @property
    def index(self) -> int:
        return self.value.bit_length() - 1


class SourceSubsystem(IntEnum):
    S_OTHER = 1 << 0
    S_IMU = 1 << 1
    S_BARO = 1 << 2
    S_GPS = 1 << 3
    S_LORA = 1 << 4
    S_SD = 1 << 5
    S_BLE = 1 << 6

    @property
    def index(self) -> int:
        return self.value.bit_length() - 1


class MessageType(IntEnum):
    T_ACCELLERATION = 1 << 0
    T_GYRO = 1 << 1
    T_ALT_SPEED = 1 << 2
    T_PRESSURE = 1 << 3
    T_TEMPERATURE = 1 << 4
    T_GPS = 1 << 5
    T_SYSLOG = 1 << 6
    T_ORIENTATION = 1 << 7

    @property
    def index(self) -> int:
        return self.value.bit_length() - 1


def _by_index(enum_cls: type[IntEnum]) -> dict[int, IntEnum]:
    return {member.value.bit_length() - 1: member for member in enum_cls}


_PAYLOAD_BY_INDEX = _by_index(MessagePayloadType)
_SRC_BY_INDEX = _by_index(SourceSubsystem)
_TYPE_BY_INDEX = _by_index(MessageType)


def _lookup(table: dict[int, IntEnum], index: int, what: str) -> IntEnum:
    try:
        return table[index]
    except KeyError:
        raise ProtocolError(f"unknown {what} index {index}") from None


def resolve_payload_type(value: str | int) -> MessagePayloadType:
    """Accept a name (``"P_FLOAT"``), a flag value, or a wire index."""
    return _resolve(MessagePayloadType, _PAYLOAD_BY_INDEX, value, "payload type")


def resolve_source(value: str | int) -> SourceSubsystem:
    return _resolve(SourceSubsystem, _SRC_BY_INDEX, value, "source subsystem")


def resolve_message_type(value: str | int) -> MessageType:
    return _resolve(MessageType, _TYPE_BY_INDEX, value, "message type")


def _resolve(
    enum_cls: type[IntEnum],
    by_index: dict[int, IntEnum],
    value: str | int,
    what: str,
) -> Any:
    if isinstance(value, enum_cls):
        return value
    if isinstance(value, str):
        name = value.strip().upper()
        if name in enum_cls.__members__:
            return enum_cls[name]
        # Allow the short form: "IMU" for "S_IMU", "float" for "P_FLOAT".
        for member in enum_cls:
            if member.name.split("_", 1)[1] == name:
                return member
        if name.isdigit():
            value = int(name)
        else:
            raise ProtocolError(f"unknown {what} {value!r}")
    if isinstance(value, int):
        try:
            return enum_cls(value)  # bit-flag value
        except ValueError:
            pass
        if value in by_index:  # wire index
            return by_index[value]
    raise ProtocolError(f"unknown {what} {value!r}")


# --- Payload codecs ------------------------------------------------------------

# payload type -> (fixed size in bytes or None for variable, struct format)
_PAYLOAD_LAYOUT: dict[MessagePayloadType, tuple[int | None, str | None]] = {
    MessagePayloadType.P_NONE: (0, None),
    MessagePayloadType.P_BOOL: (1, "<?"),
    MessagePayloadType.P_FLOAT: (4, "<f"),
    MessagePayloadType.P_DOUBLE: (8, "<d"),
    MessagePayloadType.P_INT: (4, "<i"),
    MessagePayloadType.P_LONG: (8, "<q"),
    MessagePayloadType.P_FVEC2: (8, "<2f"),
    MessagePayloadType.P_FVEC3: (12, "<3f"),
    MessagePayloadType.P_STRING: (None, None),
}


def payload_size(payload_type: MessagePayloadType) -> int | None:
    """Serialized payload size in bytes, or ``None`` when variable-length."""
    return _PAYLOAD_LAYOUT[payload_type][0]


def _decode_payload(payload_type: MessagePayloadType, raw: bytes) -> Any:
    size, fmt = _PAYLOAD_LAYOUT[payload_type]

    if payload_type is MessagePayloadType.P_STRING:
        # Variable length: the rest of the frame, minus any null terminator.
        return raw.split(b"\x00", 1)[0].decode("utf-8", errors="replace")

    if size and len(raw) < size:
        raise ProtocolError(
            f"truncated {payload_type.name} payload: got {len(raw)} B, want {size} B"
        )

    if payload_type is MessagePayloadType.P_NONE:
        return None

    values = struct.unpack_from(fmt, raw, 0)  # type: ignore[arg-type]

    if payload_type is MessagePayloadType.P_FVEC2:
        return {"x": values[0], "y": values[1]}
    if payload_type is MessagePayloadType.P_FVEC3:
        return {"x": values[0], "y": values[1], "z": values[2]}
    return values[0]


def _encode_payload(payload_type: MessagePayloadType, value: Any) -> bytes:
    size, fmt = _PAYLOAD_LAYOUT[payload_type]

    if payload_type is MessagePayloadType.P_NONE:
        return b""
    if payload_type is MessagePayloadType.P_STRING:
        return str(value).encode("utf-8")
    if payload_type is MessagePayloadType.P_FVEC2:
        x, y = _vector(value, 2)
        return struct.pack(fmt, x, y)  # type: ignore[arg-type]
    if payload_type is MessagePayloadType.P_FVEC3:
        x, y, z = _vector(value, 3)
        return struct.pack(fmt, x, y, z)  # type: ignore[arg-type]
    if payload_type is MessagePayloadType.P_BOOL:
        return struct.pack(fmt, bool(value))  # type: ignore[arg-type]
    try:
        return struct.pack(fmt, value)  # type: ignore[arg-type]
    except struct.error as exc:
        raise ProtocolError(f"cannot encode {value!r} as {payload_type.name}: {exc}") from exc


def _vector(value: Any, arity: int) -> tuple[float, ...]:
    if isinstance(value, dict):
        keys = ("x", "y", "z")[:arity]
        missing = [key for key in keys if key not in value]
        if missing:
            raise ProtocolError(f"vector payload missing {missing}")
        return tuple(float(value[key]) for key in keys)
    if isinstance(value, (list, tuple)) and len(value) == arity:
        return tuple(float(component) for component in value)
    raise ProtocolError(f"expected a {arity}-component vector, got {value!r}")


# --- Message -------------------------------------------------------------------


@dataclass(slots=True)
class LogMessage:
    """A decoded telemetry frame."""

    timestamp_us: int
    payload_type: MessagePayloadType
    src: SourceSubsystem
    type: MessageType
    payload: Any = None

    @classmethod
    def from_bytes(cls, data: bytes | bytearray | memoryview) -> "LogMessage":
        """Decode a frame. Raises :class:`ProtocolError` on malformed input."""
        raw = bytes(data)
        if len(raw) < HEADER_SIZE:
            raise ProtocolError(
                f"frame too short: got {len(raw)} B, want at least {HEADER_SIZE} B"
            )

        timestamp_us, flags = struct.unpack_from("<QH", raw, 0)

        payload_type = _lookup(
            _PAYLOAD_BY_INDEX, (flags >> _PAYLOAD_SHIFT) & _PAYLOAD_MASK, "payload type"
        )
        src = _lookup(_SRC_BY_INDEX, (flags >> _SRC_SHIFT) & _SRC_MASK, "source subsystem")
        msg_type = _lookup(
            _TYPE_BY_INDEX, (flags >> _TYPE_SHIFT) & _TYPE_MASK, "message type"
        )

        payload = _decode_payload(payload_type, raw[HEADER_SIZE:])  # type: ignore[arg-type]
        return cls(
            timestamp_us=timestamp_us,
            payload_type=payload_type,  # type: ignore[arg-type]
            src=src,  # type: ignore[arg-type]
            type=msg_type,  # type: ignore[arg-type]
            payload=payload,
        )

    def to_bytes(self) -> bytes:
        """Re-serialize the message (round-trips :meth:`from_bytes`)."""
        flags = (
            (self.payload_type.index << _PAYLOAD_SHIFT)
            | (self.src.index << _SRC_SHIFT)
            | (self.type.index << _TYPE_SHIFT)
        )
        header = struct.pack("<QH", self.timestamp_us & 0xFFFFFFFFFFFFFFFF, flags)
        return header + _encode_payload(self.payload_type, self.payload)

    def to_dict(self) -> dict[str, Any]:
        return {
            "timestamp_us": self.timestamp_us,
            "timestamp": self.timestamp_us / 1_000_000,
            "payload_type": self.payload_type.name,
            "src": self.src.name,
            "type": self.type.name,
            "payload": self.payload,
        }


def describe_enums() -> dict[str, list[dict[str, int | str]]]:
    """Enum metadata, so clients can build filters without hardcoding names."""

    def entries(enum_cls: type[IntEnum]) -> list[dict[str, int | str]]:
        return [
            {
                "name": member.name,
                "flag": int(member.value),
                "index": member.value.bit_length() - 1,
            }
            for member in enum_cls
        ]

    return {
        "payload_types": entries(MessagePayloadType),
        "sources": entries(SourceSubsystem),
        "message_types": entries(MessageType),
    }
