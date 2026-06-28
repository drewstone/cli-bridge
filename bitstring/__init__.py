import struct
import math
import binascii
from typing import Optional, Iterator, Iterable, Union, Tuple, TextIO, Any


class Error(Exception):
    pass


class ReadError(Error, IndexError):
    pass


class InterpretError(Error, ValueError):
    pass


class ByteAlignError(Error):
    pass


class CreationError(Error, ValueError):
    pass


class Options:
    def __init__(self):
        self.lsb0 = False
        self.bytealigned = False
        self.mxfp_overflow = 'saturate'
        self.no_color = False


options = Options()


BitsType = Union['Bits', str, int, bytes, bytearray, list, tuple]


def _parse_bit_length(length):
    if length is None:
        return None
    return int(length)


def _str_to_bits(s):
    s = s.replace(' ', '').replace('_', '')
    if s.startswith('0x') or s.startswith('0X'):
        hex_str = s[2:]
        if not hex_str:
            return bytearray(), 0
        data = binascii.unhexlify('0' * (len(hex_str) % 2) + hex_str)
        bits = len(hex_str) * 4
        return bytearray(data), bits
    elif s.startswith('0b') or s.startswith('0B'):
        bin_str = s[2:]
        if not bin_str:
            return bytearray(), 0
        bits = len(bin_str)
        data = bytearray((bits + 7) // 8)
        for i, c in enumerate(bin_str):
            if c == '1':
                data[i // 8] |= 1 << (7 - (i % 8))
            elif c != '0':
                raise CreationError(f"Invalid binary character: {c}")
        return data, bits
    elif s.startswith('0o') or s.startswith('0O'):
        oct_str = s[2:]
        if not oct_str:
            return bytearray(), 0
        bits = len(oct_str) * 3
        data = bytearray((bits + 7) // 8)
        for i, c in enumerate(oct_str):
            val = int(c, 8)
            bit_pos = i * 3
            for j in range(3):
                if val & (1 << (2 - j)):
                    pos = bit_pos + j
                    data[pos // 8] |= 1 << (7 - (pos % 8))
        return data, bits
    else:
        return _token_to_bits(s)


def _token_to_bits(token):
    if '=' in token:
        fmt, value = token.split('=', 1)
        fmt = fmt.strip()
        value = value.strip()
        bits = _parse_format_token(fmt, value)
        if bits is not None:
            return bits
        raise CreationError(f"Cannot parse token: {token}")
    token = token.strip()
    if token.startswith('0x') or token.startswith('0X') or \
       token.startswith('0b') or token.startswith('0B') or \
       token.startswith('0o') or token.startswith('0O'):
        return _str_to_bits(token)
    return _str_to_bits('0x' + token) if token else (bytearray(), 0)


def _parse_format_token(fmt, value):
    fmt = fmt.strip()
    colon_idx = fmt.find(':')
    if colon_idx >= 0:
        name = fmt[:colon_idx]
        length = fmt[colon_idx + 1:]
    else:
        name = fmt
        length = None

    if length:
        try:
            length = int(length)
        except ValueError:
            length = None

    if name.startswith('0x') or name.startswith('0X') or \
       name.startswith('0b') or name.startswith('0B') or \
       name.startswith('0o') or name.startswith('0O'):
        s = name
        if '=' in value:
            value_s = value
        else:
            value_s = value
        d, bl = _str_to_bits(name)
        return d, bl

    name_map = {
        'bin': 'bin', 'b': 'bin',
        'hex': 'hex', 'h': 'hex',
        'oct': 'oct', 'o': 'oct',
        'int': 'int', 'i': 'int',
        'uint': 'uint', 'u': 'uint',
        'float': 'float', 'f': 'float',
        'bytes': 'bytes',
        'bool': 'bool',
        'bits': 'bits',
        'intbe': 'intbe', 'intle': 'intle', 'intne': 'intne',
        'uintbe': 'uintbe', 'uintle': 'uintle', 'uintne': 'uintne',
        'floatbe': 'floatbe', 'floatle': 'floatle', 'floatne': 'floatne',
    }

    base_name = name
    if length is None:
        for n in ['int', 'uint', 'float', 'intbe', 'intle', 'intne',
                  'uintbe', 'uintle', 'uintne', 'floatbe', 'floatle', 'floatne',
                  'bin', 'hex', 'oct', 'bytes', 'bits']:
            if name.startswith(n):
                rest = name[len(n):]
                if rest:
                    try:
                        length = int(rest)
                        base_name = n
                    except ValueError:
                        pass
                break

    if base_name not in name_map:
        raise CreationError(f"Unknown format: {fmt}")

    kind = name_map[base_name]

    if '=' in value:
        value = value.split('=', 1)[1]

    if kind == 'bool':
        if length is None:
            length = 1
        v = 1 if value.lower() in ('true', '1', 'yes') else 0
        return _uint_to_bits(v, int(length))
    elif kind == 'bin':
        if value.startswith('0b'):
            value = value[2:]
        bits = len(value)
        data = bytearray((bits + 7) // 8)
        for i, c in enumerate(value):
            if c == '1':
                data[i // 8] |= 1 << (7 - (i % 8))
        return data, bits
    elif kind == 'hex':
        if value.startswith('0x'):
            value = value[2:]
        if length:
            bits = int(length)
            target_nibbles = (bits + 3) // 4
            value = value.zfill(target_nibbles)
            data = binascii.unhexlify('0' * (len(value) % 2) + value)
            return bytearray(data), bits
        data = binascii.unhexlify('0' * (len(value) % 2) + value)
        return bytearray(data), len(value) * 4
    elif kind == 'oct':
        if value.startswith('0o'):
            value = value[2:]
        bits = len(value) * 3 if length is None else int(length)
        data = bytearray((bits + 7) // 8)
        for i, c in enumerate(value):
            val = int(c, 8)
            for j in range(3):
                if val & (1 << (2 - j)):
                    pos = i * 3 + j
                    if pos < bits:
                        data[pos // 8] |= 1 << (7 - (pos % 8))
        return data, bits
    elif kind == 'uint':
        v = int(value)
        if length is None:
            raise CreationError("uint requires a length")
        return _uint_to_bits(v, int(length))
    elif kind == 'int':
        v = int(value)
        if length is None:
            raise CreationError("int requires a length")
        return _int_to_bits(v, int(length))
    elif kind == 'float':
        v = float(value)
        if length is None:
            length = 32
        return _float_to_bits(v, int(length))
    elif kind == 'bytes':
        v = value.encode('latin-1') if isinstance(value, str) else value
        bl = len(v) * 8
        if length:
            bl = int(length) * 8 if int(length) > 0 else int(length)
        return bytearray(v), bl
    elif kind == 'bits':
        d, bl = _auto_to_bits(value)
        if length:
            bl = int(length)
        return d, bl
    elif kind in ('intbe', 'intle', 'intne'):
        v = int(value)
        if length is None:
            raise CreationError(f"{kind} requires a length")
        length = int(length)
        if length % 8 != 0:
            raise CreationError(f"{kind} length must be multiple of 8")
        nbytes = length // 8
        if kind == 'intbe':
            packed = struct.pack('>q', v)
            return bytearray(packed[-nbytes:] if nbytes <= 8 else packed + b'\x00' * (nbytes - 8)), length
        elif kind == 'intle':
            packed = struct.pack('<q', v)
            return bytearray(packed[:nbytes] if nbytes <= 8 else packed + b'\x00' * (nbytes - 8)), length
        return _int_to_bits(v, length)
    elif kind in ('uintbe', 'uintle', 'uintne'):
        v = int(value)
        if length is None:
            raise CreationError(f"{kind} requires a length")
        length = int(length)
        if length % 8 != 0:
            raise CreationError(f"{kind} length must be multiple of 8")
        nbytes = length // 8
        if kind == 'uintbe':
            return bytearray(v.to_bytes(nbytes, 'big')), length
        elif kind == 'uintle':
            return bytearray(v.to_bytes(nbytes, 'little')), length
        return _uint_to_bits(v, length)
    elif kind in ('floatbe', 'floatle', 'floatne'):
        v = float(value)
        if length is None:
            length = 32
        if int(length) == 16:
            packed = struct.pack('>e', v)
        elif int(length) == 32:
            packed = struct.pack('>f', v)
        elif int(length) == 64:
            packed = struct.pack('>d', v)
        else:
            raise CreationError(f"float must be 16, 32 or 64 bits")
        if kind == 'floatle':
            packed = packed[::-1]
        return bytearray(packed), int(length)

    raise CreationError(f"Cannot parse format: {fmt}")


def _uint_to_bits(v, length):
    if v < 0:
        raise CreationError("Cannot assign negative value to unsigned integer")
    if v >= (1 << length):
        raise CreationError(f"Value {v} too large for {length} bits")
    data = bytearray((length + 7) // 8)
    for i in range(length):
        if v & (1 << (length - 1 - i)):
            data[i // 8] |= 1 << (7 - (i % 8))
    return data, length


def _int_to_bits(v, length):
    if v < -(1 << (length - 1)) or v >= (1 << (length - 1)):
        raise CreationError(f"Value {v} too large for signed {length} bits")
    if v >= 0:
        return _uint_to_bits(v, length)
    uv = v + (1 << length)
    return _uint_to_bits(uv, length)


def _float_to_bits(v, length):
    if length == 16:
        packed = struct.pack('>e', v)
    elif length == 32:
        packed = struct.pack('>f', v)
    elif length == 64:
        packed = struct.pack('>d', v)
    else:
        raise CreationError(f"float must be 16, 32 or 64 bits, not {length}")
    return bytearray(packed), length


def _auto_to_bits(value, length=None, offset=None, **kwargs):
    if kwargs:
        for k, v in kwargs.items():
            if k == 'bin':
                if isinstance(v, str):
                    if v.startswith('0b'):
                        v = v[2:]
                    bits = len(v)
                    data = bytearray((bits + 7) // 8)
                    for i, c in enumerate(v):
                        if c == '1':
                            data[i // 8] |= 1 << (7 - (i % 8))
                    if length is not None:
                        bits = length
                    if offset is not None:
                        data, bits = _apply_offset(data, bits, offset)
                    return data, bits
                raise CreationError("bin must be string")
            elif k == 'hex':
                if isinstance(v, str):
                    if v.startswith('0x'):
                        v = v[2:]
                    data = binascii.unhexlify('0' * (len(v) % 2) + v)
                    bits = len(v) * 4
                    if length is not None:
                        bits = length
                    if offset is not None:
                        data, bits = _apply_offset(data, bits, offset)
                    return bytearray(data), bits
                raise CreationError("hex must be string")
            elif k == 'oct':
                if isinstance(v, str):
                    if v.startswith('0o'):
                        v = v[2:]
                    bits = len(v) * 3
                    data = bytearray((bits + 7) // 8)
                    for i, c in enumerate(v):
                        val = int(c, 8)
                        for j in range(3):
                            if val & (1 << (2 - j)):
                                pos = i * 3 + j
                                data[pos // 8] |= 1 << (7 - (pos % 8))
                    if length is not None:
                        if length > bits:
                            extra = bytearray((length + 7) // 8)
                            bits = length
                            data = extra
                        else:
                            bits = length
                    if offset is not None:
                        data, bits = _apply_offset(data, bits, offset)
                    return data, bits
                raise CreationError("oct must be string")
            elif k == 'uint':
                v_int = int(v)
                if length is None:
                    raise CreationError("uint requires a length")
                return _uint_to_bits(v_int, length)
            elif k == 'int':
                v_int = int(v)
                if length is None:
                    raise CreationError("int requires a length")
                return _int_to_bits(v_int, length)
            elif k == 'float':
                v_float = float(v)
                if length is None:
                    length = 32
                return _float_to_bits(v_float, length)
            elif k == 'bool':
                v_bool = 1 if v else 0
                if length is None:
                    length = 1
                return _uint_to_bits(v_bool, length)
            elif k == 'bytes':
                if isinstance(v, str):
                    v = v.encode('latin-1')
                bl = len(v) * 8
                if length is not None:
                    bl = length
                if offset is not None:
                    v = v[offset // 8:]
                    bl -= offset
                return bytearray(v[: (bl + 7) // 8]), bl
            elif k == 'filename':
                with open(v, 'rb') as f:
                    data = bytearray(f.read())
                bl = len(data) * 8
                if offset is not None:
                    bit_offset = offset
                    byte_skip = bit_offset // 8
                    bit_rem = bit_offset % 8
                    data = data[byte_skip:]
                    if bit_rem:
                        new_data = bytearray(len(data))
                        for i in range(len(data) - 1):
                            new_data[i] = ((data[i] << bit_rem) | (data[i + 1] >> (8 - bit_rem))) & 0xff
                        new_data[-1] = (data[-1] << bit_rem) & 0xff
                        data = new_data
                    bl -= bit_offset
                if length is not None:
                    bl = length
                return data, bl
            elif k == 'se':
                pass
            elif k == 'ue':
                v_int = int(v)
                code_len = int(math.floor(math.log2(v_int + 1))) * 2 + 1
                bits_needed = code_len
                data = bytearray((bits_needed + 7) // 8)
                code = v_int + 1
                leading_zeros = (code_len - 1) // 2
                bit_pos = 0
                for _ in range(leading_zeros):
                    pass
                for j in range(code_len - 1, -1, -1):
                    if code & (1 << j):
                        data[bit_pos // 8] |= 1 << (7 - (bit_pos % 8))
                    bit_pos += 1
                return data, code_len
            else:
                raise CreationError(f"Unknown keyword: {k}")

    if value is None:
        if length is not None:
            return bytearray((length + 7) // 8), length
        return bytearray(), 0

    if isinstance(value, Bits):
        return bytearray(value._data), value._bitlength

    if isinstance(value, bytes):
        bl = len(value) * 8
        if length is not None:
            bl = length
        if offset is not None:
            bit_offset = offset
            byte_skip = bit_offset // 8
            bit_rem = bit_offset % 8
            value = value[byte_skip:]
            if bit_rem:
                val = bytearray(len(value))
                for i in range(len(value) - 1):
                    val[i] = ((value[i] << bit_rem) | (value[i + 1] >> (8 - bit_rem))) & 0xff
                if value:
                    val[-1] = (value[-1] << bit_rem) & 0xff
                value = bytes(val)
            bl -= bit_offset
        return bytearray(value[: (bl + 7) // 8]), bl

    if isinstance(value, bytearray):
        bl = len(value) * 8
        if length is not None:
            bl = length
        if offset is not None:
            bit_offset = offset
            byte_skip = bit_offset // 8
            bit_rem = bit_offset % 8
            value = value[byte_skip:]
            if bit_rem:
                new_val = bytearray(len(value))
                for i in range(len(value) - 1):
                    new_val[i] = ((value[i] << bit_rem) | (value[i + 1] >> (8 - bit_rem))) & 0xff
                if value:
                    new_val[-1] = (value[-1] << bit_rem) & 0xff
                value = new_val
            bl -= bit_offset
        return value[: (bl + 7) // 8], bl

    if isinstance(value, int):
        data = bytearray((abs(value) + 7) // 8)
        bl = abs(value)
        if length is not None:
            bl = length
        return data, bl

    if isinstance(value, str):
        parts = [p.strip() for p in value.split(',')]
        if len(parts) == 1:
            return _str_to_bits(parts[0])
        all_data = bytearray()
        all_bits = 0
        for part in parts:
            if not part:
                continue
            if part.startswith('0x') or part.startswith('0X') or \
               part.startswith('0b') or part.startswith('0B') or \
               part.startswith('0o') or part.startswith('0O'):
                d, bl = _str_to_bits(part)
            elif '=' in part:
                d, bl = _token_to_bits(part)
            else:
                d, bl = _str_to_bits('0x' + part)
            all_data.extend(d)
            all_bits += bl
        if length is not None:
            all_bits = length
        return all_data, all_bits

    if isinstance(value, (list, tuple)):
        data = bytearray((len(value) + 7) // 8)
        bl = len(value)
        for i, v in enumerate(value):
            if v:
                data[i // 8] |= 1 << (7 - (i % 8))
        if length is not None:
            bl = length
        return data, bl

    raise CreationError(f"Cannot create bitstring from {type(value)}")


def _apply_offset(data, bits, offset):
    if offset == 0:
        return data, bits
    byte_skip = offset // 8
    bit_rem = offset % 8
    new_bits = bits - offset
    if new_bits <= 0:
        return bytearray(), 0
    data = data[byte_skip:]
    if bit_rem:
        new_data = bytearray(len(data))
        for i in range(len(data) - 1):
            new_data[i] = ((data[i] << bit_rem) | (data[i + 1] >> (8 - bit_rem))) & 0xff
        if data:
            new_data[-1] = (data[-1] << bit_rem) & 0xff
        data = new_data
    return bytearray(data), new_bits


def _format_string_to_bits(fmt_str, values, kwargs):
    parts = [p.strip() for p in fmt_str.split(',')]
    all_data = bytearray()
    all_bits = 0
    value_idx = 0
    resolved = {}
    if kwargs:
        resolved.update(kwargs)
    for part in parts:
        if not part:
            continue
        if part.startswith('0x') or part.startswith('0X') or \
           part.startswith('0b') or part.startswith('0B') or \
           part.startswith('0o') or part.startswith('0O'):
            d, bl = _str_to_bits(part)
            all_data.extend(d)
            all_bits += bl
        elif '=' in part:
            d, bl = _token_to_bits(part)
            all_data.extend(d)
            all_bits += bl
        elif part.startswith('<') or part.startswith('>') or part.startswith('=') or part.startswith('@'):
            d, bl = _compact_format_to_bits(part, values, value_idx)
            all_data.extend(d)
            all_bits += bl
        else:
            d, bl = _token_to_bits(part)
            all_data.extend(d)
            all_bits += bl
    return bytearray(all_data), all_bits


def _compact_format_to_bits(fmt, values, idx):
    endian = fmt[0]
    rest = fmt[1:]
    if endian == '>':
        endian_prefix = '>'
    elif endian == '<':
        endian_prefix = '<'
    else:
        endian_prefix = '='

    fmt_map = {
        'b': ('b', 1), 'B': ('B', 1),
        'h': ('h', 2), 'H': ('H', 2),
        'i': ('i', 4), 'I': ('I', 4),
        'l': ('i', 4), 'L': ('I', 4),
        'q': ('q', 8), 'Q': ('Q', 8),
        'e': ('e', 2), 'f': ('f', 4), 'd': ('d', 8),
    }

    i = 0
    all_data = bytearray()
    while i < len(rest):
        c = rest[i]
        count = 1
        j = i + 1
        while j < len(rest) and rest[j].isdigit():
            j += 1
        if j > i + 1:
            count = int(rest[i + 1:j])
        if c in fmt_map:
            fc, sz = fmt_map[c]
            for _ in range(count):
                packed = struct.pack(endian_prefix + fc, values[idx])
                idx += 1
                all_data.extend(packed)
        else:
            raise CreationError(f"Unknown format character: {c}")
        i = j
    return all_data, len(all_data) * 8


def _parse_read_fmt(fmt):
    if isinstance(fmt, (list, tuple)):
        return list(fmt)
    parts = [p.strip() for p in fmt.split(',')]
    return parts


def _apply_step(s, step, start, stop):
    result = Bits()
    if step > 0:
        for i in range(start, stop, step):
            result += Bits(_uint_to_bits(s[i], 1))
    else:
        for i in range(start, stop, step):
            result += Bits(_uint_to_bits(s[i], 1))
    return result


class Bits:
    def __init__(self, auto=None, /, length=None, offset=None, **kwargs):
        if isinstance(auto, Bits):
            self._data = bytearray(auto._data)
            self._bitlength = auto._bitlength
            if length is not None:
                self._bitlength = length
            if offset is not None:
                d, bl = _apply_offset(self._data, self._bitlength, offset)
                self._data = d
                self._bitlength = bl
            return
        if kwargs or auto is not None:
            data, bits = _auto_to_bits(auto, length, offset, **kwargs)
            self._data = data
            self._bitlength = bits
        else:
            if length is not None:
                self._data = bytearray((length + 7) // 8)
                self._bitlength = length
            else:
                self._data = bytearray()
                self._bitlength = 0

    @property
    def len(self):
        return self._bitlength

    @property
    def length(self):
        return self._bitlength

    def __len__(self):
        return self._bitlength

    def __bool__(self):
        return self._bitlength > 0

    def _get_bit(self, index):
        if index < 0:
            index += self._bitlength
        if index < 0 or index >= self._bitlength:
            raise IndexError("Bit index out of range")
        if options.lsb0:
            index = self._bitlength - 1 - index
        byte_idx = index // 8
        bit_idx = 7 - (index % 8)
        return bool(self._data[byte_idx] & (1 << bit_idx))

    def _get_bits(self, start, stop, step):
        if step is None:
            step = 1
        if step > 0:
            if start is None:
                start = 0
            if stop is None:
                stop = self._bitlength
        else:
            if start is None:
                start = self._bitlength - 1
            if stop is None:
                stop = -1
        indices = list(range(start, stop, step))
        if not indices:
            return Bits()
        result_data = bytearray()
        for i in indices:
            val = self._get_bit(i)
            byte_pos = len(result_data) // 8
            bit_pos = 7 - (len(result_data) % 8)
            if len(result_data) % 8 == 0:
                result_data.append(0)
            if val:
                result_data[byte_pos] |= 1 << bit_pos
        return Bits.__new_instance(bytearray(result_data), len(indices))

    @classmethod
    def __new_instance(cls, data, bitlength):
        instance = cls.__new__(cls)
        instance._data = bytearray(data)
        instance._bitlength = bitlength
        return instance

    def __getitem__(self, key):
        if isinstance(key, int):
            return self._get_bit(key)
        elif isinstance(key, slice):
            start = key.start
            stop = key.stop
            step = key.step
            if start is None and stop is None and step is None:
                return self.copy()
            if options.lsb0:
                if start is not None:
                    start = self._bitlength - start
                if stop is not None:
                    stop = self._bitlength - stop
            indices = list(range(start or 0, stop or self._bitlength, step or 1))
            return self._get_bits(
                indices[0] if indices else 0,
                (indices[-1] + (1 if (step or 1) > 0 else -1)) if indices else 0,
                1
            )
        raise TypeError(f"Bitstring indices must be integers or slices, not {type(key)}")

    def __eq__(self, other):
        if isinstance(other, Bits):
            return self._bitlength == other._bitlength and self._data == other._data
        if isinstance(other, (str, int, bytes, bytearray, list, tuple)):
            try:
                other_bs = Bits(other)
                return self == other_bs
            except (CreationError, ValueError):
                return NotImplemented
        return NotImplemented

    def __ne__(self, other):
        result = self.__eq__(other)
        if result is NotImplemented:
            return result
        return not result

    def __hash__(self):
        return hash((self._bitlength, bytes(self._data)))

    def __add__(self, other):
        if isinstance(other, Bits):
            new_data = bytearray(self._data)
            if self._bitlength % 8 == 0:
                new_data.extend(other._data)
            else:
                extra_bits = self._bitlength % 8
                carry = 0
                for i in range(len(other._data)):
                    byte = other._data[i]
                    shifted = ((carry << (8 - extra_bits)) | (byte >> extra_bits)) & 0xff
                    new_data.append(shifted)
                    carry = byte & ((1 << extra_bits) - 1)
                if carry:
                    new_data.append(carry << (8 - extra_bits))
            return Bits.__new_instance(new_data, self._bitlength + other._bitlength)
        try:
            other_bs = Bits(other)
            return self + other_bs
        except (CreationError, ValueError, TypeError):
            return NotImplemented

    def __radd__(self, other):
        try:
            other_bs = Bits(other)
            return other_bs + self
        except (CreationError, ValueError, TypeError):
            return NotImplemented

    def __mul__(self, n):
        if not isinstance(n, int):
            return NotImplemented
        if n <= 0:
            return Bits()
        result = self.copy()
        for _ in range(n - 1):
            result = result + self
        return result

    def __rmul__(self, n):
        return self.__mul__(n)

    def __and__(self, other):
        if isinstance(other, Bits):
            if self._bitlength != other._bitlength:
                raise ValueError("Bitstrings must have same length for &")
            new_data = bytearray(len(self._data))
            for i in range(len(self._data)):
                if i < len(other._data):
                    new_data[i] = self._data[i] & other._data[i]
            return Bits.__new_instance(new_data, self._bitlength)
        try:
            other_bs = Bits(other)
            return self & other_bs
        except (CreationError, ValueError, TypeError):
            return NotImplemented

    def __rand__(self, other):
        try:
            other_bs = Bits(other)
            return other_bs & self
        except (CreationError, ValueError, TypeError):
            return NotImplemented

    def __or__(self, other):
        if isinstance(other, Bits):
            if self._bitlength != other._bitlength:
                raise ValueError("Bitstrings must have same length for |")
            new_data = bytearray(len(self._data))
            for i in range(len(self._data)):
                if i < len(other._data):
                    new_data[i] = self._data[i] | other._data[i]
            return Bits.__new_instance(new_data, self._bitlength)
        try:
            other_bs = Bits(other)
            return self | other_bs
        except (CreationError, ValueError, TypeError):
            return NotImplemented

    def __ror__(self, other):
        try:
            other_bs = Bits(other)
            return other_bs | self
        except (CreationError, ValueError, TypeError):
            return NotImplemented

    def __xor__(self, other):
        if isinstance(other, Bits):
            if self._bitlength != other._bitlength:
                raise ValueError("Bitstrings must have same length for ^")
            new_data = bytearray(len(self._data))
            for i in range(len(self._data)):
                if i < len(other._data):
                    new_data[i] = self._data[i] ^ other._data[i]
            return Bits.__new_instance(new_data, self._bitlength)
        try:
            other_bs = Bits(other)
            return self ^ other_bs
        except (CreationError, ValueError, TypeError):
            return NotImplemented

    def __rxor__(self, other):
        try:
            other_bs = Bits(other)
            return other_bs ^ self
        except (CreationError, ValueError, TypeError):
            return NotImplemented

    def __invert__(self):
        if self._bitlength == 0:
            raise Error("Cannot invert an empty bitstring")
        new_data = bytearray(len(self._data))
        for i in range(len(self._data)):
            new_data[i] = ~self._data[i] & 0xff
        last_byte_bits = self._bitlength % 8
        if last_byte_bits > 0:
            mask = (1 << (8 - last_byte_bits)) - 1
            new_data[-1] = new_data[-1] & ~mask
        return Bits.__new_instance(new_data, self._bitlength)

    def __lshift__(self, n):
        if n <= 0:
            return self.copy()
        if n >= self._bitlength:
            return Bits(length=self._bitlength)
        data = bytearray((self._bitlength + 7) // 8)
        bit_length = self._bitlength
        for i in range(bit_length - n):
            val = self._get_bit(i)
            if val:
                byte_idx = i // 8
                bit_idx = 7 - (i % 8)
                if byte_idx < len(data):
                    pass
                target_idx = i + n
                target_byte = target_idx // 8
                target_bit = 7 - (target_idx % 8)
                if target_byte < len(data):
                    data[target_byte] |= 1 << target_bit
        return Bits.__new_instance(data, bit_length)

    def __rshift__(self, n):
        if n <= 0:
            return self.copy()
        if n >= self._bitlength:
            return Bits(length=self._bitlength)
        data = bytearray((self._bitlength + 7) // 8)
        bit_length = self._bitlength
        for i in range(n, bit_length):
            val = self._get_bit(i)
            if val:
                target_idx = i - n
                target_byte = target_idx // 8
                target_bit = 7 - (target_idx % 8)
                if target_byte < len(data):
                    data[target_byte] |= 1 << target_bit
        return Bits.__new_instance(data, bit_length)

    def __contains__(self, other):
        if isinstance(other, Bits):
            return self.find(other, bytealigned=None) != ()
        try:
            other_bs = Bits(other)
            return self.find(other_bs, bytealigned=None) != ()
        except (CreationError, ValueError, TypeError):
            return NotImplemented

    def __copy__(self):
        return self.copy()

    def __repr__(self):
        if self._bitlength == 0:
            return "Bits('')"
        if self._bitlength % 4 == 0:
            h = self.hex
            if len(h) > 40:
                h = h[:40] + '...'
            return f"Bits('0x{h}')"
        b = self.bin
        if len(b) > 40:
            b = b[:40] + '...'
        return f"Bits('0b{b}')"

    def __str__(self):
        if self._bitlength == 0:
            return "''"
        if self._bitlength % 4 == 0:
            h = self.hex
            if len(h) > 40:
                return f"0x{h[:40]}... (length={self._bitlength})"
            return f"0x{h}"
        b = self.bin
        if len(b) > 40:
            return f"0b{b[:40]}... (length={self._bitlength})"
        return f"0b{b}"

    def copy(self):
        return Bits.__new_instance(bytearray(self._data), self._bitlength)

    def all(self, value, pos=None):
        if pos is None:
            pos = range(self._bitlength)
        val = 1 if value else 0
        for p in pos:
            if p < 0:
                p += self._bitlength
            if p < 0 or p >= self._bitlength:
                raise IndexError("Bit index out of range")
            byte_idx = p // 8
            bit_idx = 7 - (p % 8)
            actual = 1 if (self._data[byte_idx] & (1 << bit_idx)) else 0
            if actual != val:
                return False
        return True

    def any(self, value, pos=None):
        if pos is None:
            pos = range(self._bitlength)
        val = 1 if value else 0
        for p in pos:
            if p < 0:
                p += self._bitlength
            if p < 0 or p >= self._bitlength:
                raise IndexError("Bit index out of range")
            byte_idx = p // 8
            bit_idx = 7 - (p % 8)
            actual = 1 if (self._data[byte_idx] & (1 << bit_idx)) else 0
            if actual == val:
                return True
        return False

    def count(self, value):
        val = 1 if value else 0
        count = 0
        for i in range(self._bitlength):
            byte_idx = i // 8
            bit_idx = 7 - (i % 8)
            if (self._data[byte_idx] >> bit_idx) & 1 == val:
                count += 1
        return count

    def cut(self, bits, start=None, end=None, count=None):
        if start is None:
            start = 0
        if end is None:
            end = self._bitlength
        n = 0
        pos = start
        while pos + bits <= end:
            yield self[pos:pos + bits]
            n += 1
            if count is not None and n >= count:
                break
            pos += bits

    def startswith(self, bs, start=None, end=None):
        if isinstance(bs, Bits):
            prefix = bs
        else:
            prefix = Bits(bs)
        if start is None:
            start = 0
        if end is None:
            end = self._bitlength
        slice_len = end - start
        if prefix._bitlength > slice_len:
            return False
        actual = self[start:start + prefix._bitlength]
        return actual == prefix

    def endswith(self, bs, start=None, end=None):
        if isinstance(bs, Bits):
            suffix = bs
        else:
            suffix = Bits(bs)
        if start is None:
            start = 0
        if end is None:
            end = self._bitlength
        slice_len = end - start
        if suffix._bitlength > slice_len:
            return False
        actual = self[end - suffix._bitlength:end]
        return actual == suffix

    def find(self, bs, start=None, end=None, bytealigned=None):
        if isinstance(bs, Bits):
            target = bs
        else:
            target = Bits(bs)

        if bytealigned is None:
            bytealigned = options.bytealigned

        if start is None:
            start = 0
        if end is None:
            end = self._bitlength

        target_len = target._bitlength
        if target_len == 0:
            return ()

        max_start = end - target_len
        step = 8 if bytealigned else 1

        for pos in range(start, max_start + 1, step):
            if self[pos:pos + target_len] == target:
                return (pos,)
        return ()

    def rfind(self, bs, start=None, end=None, bytealigned=None):
        if isinstance(bs, Bits):
            target = bs
        else:
            target = Bits(bs)

        if bytealigned is None:
            bytealigned = options.bytealigned

        if start is None:
            start = 0
        if end is None:
            end = self._bitlength

        target_len = target._bitlength
        if target_len == 0:
            return ()

        max_start = end - target_len
        step = 8 if bytealigned else 1

        for pos in range(max_start, start - 1, -step):
            if self[pos:pos + target_len] == target:
                return (pos,)
        return ()

    def findall(self, bs, start=None, end=None, count=None, bytealigned=None):
        if isinstance(bs, Bits):
            target = bs
        else:
            target = Bits(bs)

        if bytealigned is None:
            bytealigned = options.bytealigned

        if start is None:
            start = 0
        if end is None:
            end = self._bitlength

        target_len = target._bitlength
        if target_len == 0:
            return

        max_start = end - target_len
        step = 8 if bytealigned else 1
        n = 0

        for pos in range(start, max_start + 1, step):
            if self[pos:pos + target_len] == target:
                yield pos
                n += 1
                if count is not None and n >= count:
                    break

    def split(self, delimiter, start=None, end=None, count=None, bytealigned=None):
        if isinstance(delimiter, Bits):
            delim = delimiter
        else:
            delim = Bits(delimiter)

        if bytealigned is None:
            bytealigned = options.bytealigned

        if start is None:
            start = 0
        if end is None:
            end = self._bitlength

        delim_len = delim._bitlength
        n = 0
        pos = start

        while pos < end:
            if delim_len == 0:
                yield self[pos:end]
                break
            found_pos = -1
            max_start = end - delim_len
            step = 8 if bytealigned else 1
            for p in range(pos, max_start + 1, step):
                if self[p:p + delim_len] == delim:
                    found_pos = p
                    break
            if found_pos == -1:
                yield self[pos:end]
                break
            yield self[pos:found_pos]
            pos = found_pos + delim_len
            n += 1
            if count is not None and n >= count:
                yield self[pos:end]
                break
        else:
            if pos >= end:
                yield Bits()

    def join(self, sequence):
        result = Bits()
        first = True
        for item in sequence:
            if isinstance(item, Bits):
                bs = item
            else:
                bs = Bits(item)
            if not first:
                result = result + self
            result = result + bs
            first = False
        return result

    @classmethod
    def fromstring(cls, s):
        return cls(s)

    def tobytes(self):
        extra_bits = self._bitlength % 8
        if extra_bits == 0:
            return bytes(self._data)
        last_byte = self._data[-1] if self._data else 0
        padding = (8 - extra_bits)
        return bytes(self._data[:len(self._data) - 1] if extra_bits else self._data) + bytes([last_byte & (0xff << padding)])

    def tofile(self, f):
        f.write(self.tobytes())

    def tobitarray(self):
        try:
            from bitarray import bitarray
        except ImportError:
            raise ImportError("The 'bitarray' package is required for tobitarray()")
        ba = bitarray()
        for i in range(self._bitlength):
            ba.append(self._get_bit(i))
        return ba

    def unpack(self, fmt, **kwargs):
        if isinstance(fmt, str):
            tokens = [t.strip() for t in fmt.split(',')]
        else:
            tokens = list(fmt)

        result = []
        pos = 0
        remaining_kwargs = dict(kwargs)

        for token in tokens:
            if not token:
                continue
            if token.startswith('0x') or token.startswith('0X') or \
               token.startswith('0b') or token.startswith('0B') or \
               token.startswith('0o') or token.startswith('0O'):
                d, bl = _str_to_bits(token)
                result.append(Bits.__new_instance(bytearray(d), bl))
                pos += bl
                continue
            if '=' in token:
                d, bl = _token_to_bits(token)
                result.append(Bits.__new_instance(bytearray(d), bl))
                pos += bl
                continue

            colon_idx = token.find(':')
            if colon_idx >= 0:
                name = token[:colon_idx]
                length_str = token[colon_idx + 1:]
            else:
                name = token
                length_str = None

            if length_str and length_str in remaining_kwargs:
                length_str = str(remaining_kwargs.pop(length_str))

            length = int(length_str) if length_str and length_str.isdigit() else None

            base_name = name
            if length is None:
                for n in ['int', 'uint', 'intbe', 'intle', 'intne',
                          'uintbe', 'uintle', 'uintne',
                          'float', 'floatbe', 'floatle', 'floatne',
                          'bin', 'hex', 'oct', 'bytes', 'bits']:
                    if name.startswith(n):
                        rest = name[len(n):]
                        if rest and rest.isdigit():
                            length = int(rest)
                            base_name = n
                        elif rest:
                            pass
                        break

            name_lower = base_name.lower()
            if name_lower == 'pad':
                if length is None:
                    length = self._bitlength - pos
                pos += length
                result.append(None)
                continue
            elif name_lower in ('bin', 'b'):
                if length is None:
                    length = self._bitlength - pos
                result.append(self[pos:pos + length].bin)
                pos += length
            elif name_lower in ('hex', 'h'):
                if length is None:
                    length = self._bitlength - pos
                result.append(self[pos:pos + length].hex)
                pos += length
            elif name_lower in ('oct', 'o'):
                if length is None:
                    length = self._bitlength - pos
                result.append(self[pos:pos + length].oct)
                pos += length
            elif name_lower == 'uint':
                if length is None:
                    length = self._bitlength - pos
                result.append(self[pos:pos + length].uint)
                pos += length
            elif name_lower == 'int':
                if length is None:
                    length = self._bitlength - pos
                result.append(self[pos:pos + length].int)
                pos += length
            elif name_lower == 'float':
                if length is None:
                    length = self._bitlength - pos
                result.append(self[pos:pos + length].float)
                pos += length
            elif name_lower == 'bool':
                result.append(self[pos])
                pos += 1
            elif name_lower in ('bytes',):
                if length is None:
                    nbytes = (self._bitlength - pos) // 8
                else:
                    nbytes = length
                bits_needed = nbytes * 8
                b = self[pos:pos + bits_needed]
                result.append(b.bytes if b._bitlength % 8 == 0 else b.tobytes())
                pos += bits_needed
            elif name_lower == 'bits':
                if length is None:
                    length = self._bitlength - pos
                result.append(self[pos:pos + length])
                pos += length
            elif name_lower == 'uintbe':
                if length is None:
                    length = self._bitlength - pos
                result.append(self[pos:pos + length].uintbe)
                pos += length
            elif name_lower == 'uintle':
                if length is None:
                    length = self._bitlength - pos
                result.append(self[pos:pos + length].uintle)
                pos += length
            elif name_lower == 'intbe':
                if length is None:
                    length = self._bitlength - pos
                result.append(self[pos:pos + length].intbe)
                pos += length
            elif name_lower == 'intle':
                if length is None:
                    length = self._bitlength - pos
                result.append(self[pos:pos + length].intle)
                pos += length
            elif name_lower in ('floatbe', 'float'):
                if length is None:
                    length = self._bitlength - pos
                result.append(self[pos:pos + length].float)
                pos += length
            elif name_lower == 'floatle':
                if length is None:
                    length = self._bitlength - pos
                result.append(self[pos:pos + length].floatle)
                pos += length
            else:
                raise InterpretError(f"Unknown format token: {token}")
        return result

    def pp(self, fmt=None, width=120, sep=' ', show_offset=True, stream=None):
        if stream is None:
            import sys
            stream = sys.stdout
        if fmt is None:
            fmt = 'bin8, hex'
        parts = fmt.split(',')
        formats = [p.strip() for p in parts]

        line_start = f"<{type(self).__name__}, fmt='{fmt}', length={self._bitlength} bits>"
        stream.write(line_start + '\n')

        if self._bitlength == 0:
            stream.write('[]\n')
            return

        offset_width = len(str(self._bitlength))
        pos = 0
        row = 0
        while pos < self._bitlength:
            if show_offset:
                offset_str = f"{pos:{offset_width}d}: "
            else:
                offset_str = ""

            line_bits = []
            for fmt_part in formats:
                colon_idx = fmt_part.find(':')
                if colon_idx >= 0:
                    name = fmt_part[:colon_idx]
                    bits_per_group = int(fmt_part[colon_idx + 1:])
                else:
                    name = fmt_part
                    if name.startswith('bin'):
                        bits_per_group = 8
                    elif name.startswith('hex'):
                        bits_per_group = 4
                    else:
                        bits_per_group = 8

                end = min(pos + bits_per_group, self._bitlength)
                chunk = self[pos:end]
                if name.startswith('bin') or name == 'b':
                    line_bits.append(chunk.bin)
                elif name.startswith('hex') or name == 'h':
                    line_bits.append(chunk.hex)
                elif name.startswith('oct') or name == 'o':
                    line_bits.append(chunk.oct)
                elif name.startswith('int') or name == 'i':
                    line_bits.append(str(chunk.int))
                elif name.startswith('uint') or name == 'u':
                    line_bits.append(str(chunk.uint))
                elif name.startswith('bytes'):
                    line_bits.append(chunk.hex)
                else:
                    line_bits.append(chunk.bin)
                pos = end
                if pos >= self._bitlength:
                    break

            line = offset_str + sep.join(line_bits)
            stream.write(f"  {line}\n".rstrip() + '\n')
            row += 1
            if pos >= self._bitlength:
                break

    @property
    def bin(self):
        chars = []
        for i in range(self._bitlength):
            byte_idx = i // 8
            bit_idx = 7 - (i % 8)
            chars.append('1' if (self._data[byte_idx] & (1 << bit_idx)) else '0')
        return ''.join(chars)

    @property
    def b(self):
        return self.bin

    @property
    def hex(self):
        if self._bitlength % 4 != 0:
            raise InterpretError("Cannot interpret as hex: bitstring length not a multiple of 4")
        nibbles = self._bitlength // 4
        chars = []
        for i in range(nibbles):
            byte_idx = (i * 4) // 8
            bit_idx = 7 - ((i * 4) % 8)
            nibble = 0
            for j in range(4):
                pos = i * 4 + j
                byte_idx = pos // 8
                bit_idx = 7 - (pos % 8)
                if self._data[byte_idx] & (1 << bit_idx):
                    nibble |= (1 << (3 - j))
            chars.append('0123456789abcdef'[nibble])
        return ''.join(chars)

    @property
    def h(self):
        return self.hex

    @property
    def oct(self):
        if self._bitlength % 3 != 0:
            raise InterpretError("Cannot interpret as octal: bitstring length not a multiple of 3")
        groups = self._bitlength // 3
        chars = []
        for i in range(groups):
            val = 0
            for j in range(3):
                pos = i * 3 + j
                byte_idx = pos // 8
                bit_idx = 7 - (pos % 8)
                if self._data[byte_idx] & (1 << bit_idx):
                    val |= (1 << (2 - j))
            chars.append(str(val))
        return ''.join(chars)

    @property
    def o(self):
        return self.oct

    @property
    def uint(self):
        val = 0
        for i in range(self._bitlength):
            byte_idx = i // 8
            bit_idx = 7 - (i % 8)
            val = (val << 1) | ((self._data[byte_idx] >> bit_idx) & 1)
        return val

    @property
    def u(self):
        return self.uint

    @property
    def int(self):
        if self._bitlength == 0:
            raise InterpretError("Cannot interpret empty bitstring as int")
        u = self.uint
        if u & (1 << (self._bitlength - 1)):
            return u - (1 << self._bitlength)
        return u

    @property
    def i(self):
        return self.int

    @property
    def float(self):
        if self._bitlength not in (16, 32, 64):
            raise InterpretError("float property only valid for 16, 32 or 64 bit bitstrings")
        if self._bitlength == 16:
            return struct.unpack('>e', bytes(self._data[:2]))[0]
        elif self._bitlength == 32:
            return struct.unpack('>f', bytes(self._data[:4]))[0]
        else:
            return struct.unpack('>d', bytes(self._data[:8]))[0]

    @property
    def f(self):
        return self.float

    @property
    def floatbe(self):
        return self.float

    @property
    def floatle(self):
        if self._bitlength not in (16, 32, 64):
            raise InterpretError("floatle property only valid for 16, 32 or 64 bit bitstrings")
        if self._bitlength == 16:
            return struct.unpack('<e', bytes(self._data[:2]))[0]
        elif self._bitlength == 32:
            return struct.unpack('<f', bytes(self._data[:4]))[0]
        else:
            return struct.unpack('<d', bytes(self._data[:8]))[0]

    @property
    def floatne(self):
        if self._bitlength not in (16, 32, 64):
            raise InterpretError("floatne property only valid for 16, 32 or 64 bit bitstrings")
        if self._bitlength == 16:
            return struct.unpack('=e', bytes(self._data[:2]))[0]
        elif self._bitlength == 32:
            return struct.unpack('=f', bytes(self._data[:4]))[0]
        else:
            return struct.unpack('=d', bytes(self._data[:8]))[0]

    @property
    def bool(self):
        if self._bitlength != 1:
            raise InterpretError("bool property only valid for single bit bitstrings")
        return self._get_bit(0)

    @property
    def bytes(self):
        if self._bitlength % 8 != 0:
            raise InterpretError("Cannot get bytes property: bitstring not a whole number of bytes")
        return bytes(self._data[:self._bitlength // 8])

    @property
    def intbe(self):
        if self._bitlength % 8 != 0:
            raise InterpretError("intbe only valid for whole-byte bitstrings")
        nbytes = self._bitlength // 8
        return int.from_bytes(bytes(self._data[:nbytes]), 'big', signed=True)

    @property
    def intle(self):
        if self._bitlength % 8 != 0:
            raise InterpretError("intle only valid for whole-byte bitstrings")
        nbytes = self._bitlength // 8
        return int.from_bytes(bytes(self._data[:nbytes]), 'little', signed=True)

    @property
    def intne(self):
        import sys
        if self._bitlength % 8 != 0:
            raise InterpretError("intne only valid for whole-byte bitstrings")
        nbytes = self._bitlength // 8
        if sys.byteorder == 'little':
            return self.intle
        return self.intbe

    @property
    def uintbe(self):
        if self._bitlength % 8 != 0:
            raise InterpretError("uintbe only valid for whole-byte bitstrings")
        nbytes = self._bitlength // 8
        return int.from_bytes(bytes(self._data[:nbytes]), 'big', signed=False)

    @property
    def uintle(self):
        if self._bitlength % 8 != 0:
            raise InterpretError("uintle only valid for whole-byte bitstrings")
        nbytes = self._bitlength // 8
        return int.from_bytes(bytes(self._data[:nbytes]), 'little', signed=False)

    @property
    def uintne(self):
        import sys
        if self._bitlength % 8 != 0:
            raise InterpretError("uintne only valid for whole-byte bitstrings")
        nbytes = self._bitlength // 8
        if sys.byteorder == 'little':
            return self.uintle
        return self.uintbe


class BitArray(Bits):
    def __init__(self, auto=None, /, length=None, offset=None, **kwargs):
        super().__init__(auto, length=length, offset=offset, **kwargs)

    def __setitem__(self, key, value):
        if isinstance(value, Bits):
            bs = value
        else:
            bs = Bits(value)

        if isinstance(key, int):
            if key < 0:
                key += self._bitlength
            if key < 0 or key >= self._bitlength:
                raise IndexError("Bit index out of range")
            val = bs._get_bit(0) if bs._bitlength > 0 else 0
            byte_idx = key // 8
            bit_idx = 7 - (key % 8)
            if val:
                self._data[byte_idx] |= 1 << bit_idx
            else:
                self._data[byte_idx] &= ~(1 << bit_idx)
        elif isinstance(key, slice):
            start, stop, step = key.indices(self._bitlength)
            if step != 1:
                raise ValueError("Extended slices not supported for assignment")
            slice_len = stop - start
            if bs._bitlength != slice_len:
                new_len = self._bitlength - slice_len + bs._bitlength
                new_data = bytearray((new_len + 7) // 8)
                if start > 0:
                    for i in range(start):
                        byte_idx = i // 8
                        bit_idx = 7 - (i % 8)
                        if self._data[byte_idx] & (1 << bit_idx):
                            new_data[i // 8] |= 1 << (7 - (i % 8))
                bs_pos = 0
                for i in range(start, start + bs._bitlength):
                    val = bs._get_bit(bs_pos)
                    if val:
                        new_data[i // 8] |= 1 << (7 - (i % 8))
                    bs_pos += 1
                src_pos = stop
                dst_pos = start + bs._bitlength
                while src_pos < self._bitlength and dst_pos < new_len:
                    val = self._get_bit(src_pos)
                    if val:
                        new_data[dst_pos // 8] |= 1 << (7 - (dst_pos % 8))
                    src_pos += 1
                    dst_pos += 1
                self._data = new_data
                self._bitlength = new_len
            else:
                for i in range(start, stop):
                    val = bs._get_bit(i - start)
                    byte_idx = i // 8
                    bit_idx = 7 - (i % 8)
                    if val:
                        self._data[byte_idx] |= 1 << bit_idx
                    else:
                        self._data[byte_idx] &= ~(1 << bit_idx)

    def __delitem__(self, key):
        if isinstance(key, int):
            if key < 0:
                key += self._bitlength
            self._remove_bits(key, 1)
        elif isinstance(key, slice):
            start, stop, step = key.indices(self._bitlength)
            if step != 1:
                raise ValueError("Extended slices not supported for deletion")
            self._remove_bits(start, stop - start)

    def _remove_bits(self, start, count):
        if start < 0 or start + count > self._bitlength:
            raise IndexError("Slice out of range")
        new_len = self._bitlength - count
        new_data = bytearray((new_len + 7) // 8) if new_len > 0 else bytearray()
        dst = 0
        for i in range(self._bitlength):
            if start <= i < start + count:
                continue
            val = self._get_bit(i)
            if val:
                new_data[dst // 8] |= 1 << (7 - (dst % 8))
            dst += 1
        self._data = new_data
        self._bitlength = new_len

    def __iadd__(self, other):
        if isinstance(other, Bits):
            other_bs = other
        else:
            other_bs = Bits(other)
        if self._bitlength == 0:
            self._data = bytearray(other_bs._data)
            self._bitlength = other_bs._bitlength
            return self
        if self._bitlength % 8 == 0:
            self._data.extend(other_bs._data)
        else:
            extra_bits = self._bitlength % 8
            carry = 0
            for i in range(len(other_bs._data)):
                byte = other_bs._data[i]
                shifted = ((carry << (8 - extra_bits)) | (byte >> extra_bits)) & 0xff
                self._data.append(shifted)
                carry = byte & ((1 << extra_bits) - 1)
            if carry:
                self._data.append(carry << (8 - extra_bits))
        self._bitlength += other_bs._bitlength
        return self

    def __imul__(self, n):
        if n <= 0:
            self._data = bytearray()
            self._bitlength = 0
            return self
        original = self.copy()
        for _ in range(n - 1):
            self += original
        return self

    def __iand__(self, other):
        if isinstance(other, Bits):
            other_bs = other
        else:
            other_bs = Bits(other)
        if self._bitlength != other_bs._bitlength:
            raise ValueError("Bitstrings must have same length for &=")
        for i in range(len(self._data)):
            if i < len(other_bs._data):
                self._data[i] &= other_bs._data[i]
        return self

    def __ior__(self, other):
        if isinstance(other, Bits):
            other_bs = other
        else:
            other_bs = Bits(other)
        if self._bitlength != other_bs._bitlength:
            raise ValueError("Bitstrings must have same length for |=")
        for i in range(len(self._data)):
            if i < len(other_bs._data):
                self._data[i] |= other_bs._data[i]
        return self

    def __ixor__(self, other):
        if isinstance(other, Bits):
            other_bs = other
        else:
            other_bs = Bits(other)
        if self._bitlength != other_bs._bitlength:
            raise ValueError("Bitstrings must have same length for ^=")
        for i in range(len(self._data)):
            if i < len(other_bs._data):
                self._data[i] ^= other_bs._data[i]
        return self

    def __ilshift__(self, n):
        if n <= 0:
            return self
        if n >= self._bitlength:
            self._data = bytearray((self._bitlength + 7) // 8)
            return self
        new_data = bytearray((self._bitlength + 7) // 8)
        for i in range(n, self._bitlength):
            val = self._get_bit(i)
            if val:
                target = i - n
                new_data[target // 8] |= 1 << (7 - (target % 8))
        self._data = new_data
        return self

    def __irshift__(self, n):
        if n <= 0:
            return self
        if n >= self._bitlength:
            self._data = bytearray((self._bitlength + 7) // 8)
            return self
        new_data = bytearray((self._bitlength + 7) // 8)
        for i in range(self._bitlength - n):
            val = self._get_bit(i)
            if val:
                target = i + n
                new_data[target // 8] |= 1 << (7 - (target % 8))
        self._data = new_data
        return self

    def append(self, bs):
        if isinstance(bs, Bits):
            self += bs
        else:
            self += Bits(bs)

    def prepend(self, bs):
        if isinstance(bs, Bits):
            bs_copy = bs
        else:
            bs_copy = Bits(bs)
        new_len = self._bitlength + bs_copy._bitlength
        new_data = bytearray((new_len + 7) // 8)
        for i in range(bs_copy._bitlength):
            val = bs_copy._get_bit(i)
            if val:
                new_data[i // 8] |= 1 << (7 - (i % 8))
        for i in range(self._bitlength):
            val = self._get_bit(i)
            if val:
                dst = i + bs_copy._bitlength
                new_data[dst // 8] |= 1 << (7 - (dst % 8))
        self._data = new_data
        self._bitlength = new_len

    def insert(self, bs, pos=None):
        if pos is None:
            pos = getattr(self, 'pos', self._bitlength)
        if isinstance(bs, Bits):
            bs_copy = bs
        else:
            bs_copy = Bits(bs)
        new_len = self._bitlength + bs_copy._bitlength
        new_data = bytearray((new_len + 7) // 8)
        dst = 0
        for i in range(pos):
            val = self._get_bit(i)
            if val:
                new_data[dst // 8] |= 1 << (7 - (dst % 8))
            dst += 1
        for i in range(bs_copy._bitlength):
            val = bs_copy._get_bit(i)
            if val:
                new_data[dst // 8] |= 1 << (7 - (dst % 8))
            dst += 1
        for i in range(pos, self._bitlength):
            val = self._get_bit(i)
            if val:
                new_data[dst // 8] |= 1 << (7 - (dst % 8))
            dst += 1
        self._data = new_data
        self._bitlength = new_len

    def overwrite(self, bs, pos=None):
        if pos is None:
            pos = getattr(self, 'pos', 0)
        if isinstance(bs, Bits):
            bs_copy = bs
        else:
            bs_copy = Bits(bs)
        for i in range(bs_copy._bitlength):
            if pos + i >= self._bitlength:
                break
            val = bs_copy._get_bit(i)
            byte_idx = (pos + i) // 8
            bit_idx = 7 - ((pos + i) % 8)
            if val:
                self._data[byte_idx] |= 1 << bit_idx
            else:
                self._data[byte_idx] &= ~(1 << bit_idx)

    def reverse(self, start=None, end=None):
        if start is None:
            start = 0
        if end is None:
            end = self._bitlength
        sub = self[start:end]
        rev_data = bytearray((end - start + 7) // 8)
        for i in range(end - start):
            val = sub._get_bit(end - start - 1 - i)
            if val:
                rev_data[i // 8] |= 1 << (7 - (i % 8))
        self[start:end] = Bits.__new_instance(rev_data, end - start)

    def invert(self, pos=None):
        if pos is None:
            pos = range(self._bitlength)
        if isinstance(pos, int):
            positions = [pos]
        else:
            positions = pos
        for p in positions:
            if p < 0:
                p += self._bitlength
            if p < 0 or p >= self._bitlength:
                raise IndexError("Bit index out of range")
            byte_idx = p // 8
            bit_idx = 7 - (p % 8)
            self._data[byte_idx] ^= (1 << bit_idx)

    def set(self, value, pos=None):
        val = 1 if value else 0
        if pos is None:
            if val:
                for i in range(len(self._data)):
                    self._data[i] = 0xff
                extra_bits = self._bitlength % 8
                if extra_bits > 0:
                    mask = (1 << (8 - extra_bits)) - 1
                    self._data[-1] &= ~mask
            else:
                for i in range(len(self._data)):
                    self._data[i] = 0x00
            return
        if isinstance(pos, int):
            positions = [pos]
        else:
            positions = pos
        for p in positions:
            if isinstance(p, range):
                for rp in p:
                    if rp < 0:
                        rp += self._bitlength
                    if 0 <= rp < self._bitlength:
                        byte_idx = rp // 8
                        bit_idx = 7 - (rp % 8)
                        if val:
                            self._data[byte_idx] |= 1 << bit_idx
                        else:
                            self._data[byte_idx] &= ~(1 << bit_idx)
            else:
                if p < 0:
                    p += self._bitlength
                if p < 0 or p >= self._bitlength:
                    raise IndexError("Bit index out of range")
                byte_idx = p // 8
                bit_idx = 7 - (p % 8)
                if val:
                    self._data[byte_idx] |= 1 << bit_idx
                else:
                    self._data[byte_idx] &= ~(1 << bit_idx)

    def replace(self, old, new, start=None, end=None, count=None, bytealigned=None):
        if isinstance(old, Bits):
            old_bs = old
        else:
            old_bs = Bits(old)
        if isinstance(new, Bits):
            new_bs = new
        else:
            new_bs = Bits(new)

        if bytealigned is None:
            bytealigned = options.bytealigned

        if start is None:
            start = 0
        if end is None:
            end = self._bitlength

        replacements = 0
        pos = start
        old_len = old_bs._bitlength
        new_len = new_bs._bitlength

        while pos <= end - old_len:
            step = 8 if bytealigned else 1
            found = False
            for p in range(pos, end - old_len + 1, step):
                if self[p:p + old_len] == old_bs:
                    found = True
                    pos = p
                    break
            if not found:
                break

            if old_len == new_len:
                self[pos:pos + old_len] = new_bs
            else:
                before = self[:pos]
                after = self[pos + old_len:]
                self._bitlength = before._bitlength + new_len + after._bitlength
                new_data = bytearray((self._bitlength + 7) // 8)
                dst = 0
                for i in range(before._bitlength):
                    val = before._get_bit(i)
                    if val:
                        new_data[dst // 8] |= 1 << (7 - (dst % 8))
                    dst += 1
                for i in range(new_bs._bitlength):
                    val = new_bs._get_bit(i)
                    if val:
                        new_data[dst // 8] |= 1 << (7 - (dst % 8))
                    dst += 1
                for i in range(after._bitlength):
                    val = after._get_bit(i)
                    if val:
                        new_data[dst // 8] |= 1 << (7 - (dst % 8))
                    dst += 1
                self._data = new_data
                end = end - old_len + new_len

            replacements += 1
            pos += new_len
            if count is not None and replacements >= count:
                break

        return replacements

    def byteswap(self, fmt=None, start=None, end=None, repeat=True):
        if fmt is None:
            fmt = 0
        if start is None:
            start = 0
        if end is None:
            end = self._bitlength

        if isinstance(fmt, int):
            if fmt == 0:
                nbytes = (end - start) // 8
                if nbytes <= 1:
                    return 0
                sub = self[start:end]
                reversed_sub = Bits()
                for i in range(nbytes):
                    byte_val = sub[i * 8:(i + 1) * 8]
                    reversed_sub = Bits() + reversed_sub + byte_val
                self[start:end] = reversed_sub
                return 1
            else:
                byte_sizes = [fmt]
        elif isinstance(fmt, (list, tuple)):
            byte_sizes = list(fmt)
        elif isinstance(fmt, str):
            endian_map = {'<': '<', '>': '>', '=': '=', '@': '='}
            if fmt[0] in endian_map:
                fmt = fmt[1:]
            fmt_map = {
                'b': 1, 'B': 1, 'h': 2, 'H': 2, 'i': 4, 'I': 4,
                'l': 4, 'L': 4, 'q': 8, 'Q': 8, 'e': 2, 'f': 4, 'd': 8
            }
            byte_sizes = []
            for c in fmt:
                if c in fmt_map:
                    byte_sizes.append(fmt_map[c])
            if not byte_sizes:
                byte_sizes = [0]
        else:
            raise TypeError("byteswap fmt must be int, list, tuple or string")

        swaps = 0
        pos = start
        if repeat:
            while pos < end:
                for sz in byte_sizes:
                    if sz == 0:
                        nbytes = (end - pos) // 8
                        if nbytes <= 1:
                            return swaps
                        sub = self[pos:pos + nbytes * 8]
                        rev = Bits()
                        for i in range(nbytes):
                            rev = Bits() + rev + sub[i * 8:(i + 1) * 8]
                        self[pos:pos + nbytes * 8] = rev
                        swaps += 1
                        pos += nbytes * 8
                    else:
                        bits_needed = sz * 8
                        if pos + bits_needed > end:
                            return swaps
                        sub = self[pos:pos + bits_needed]
                        rev = Bits()
                        for i in range(sz):
                            rev = Bits() + rev + sub[i * 8:(i + 1) * 8]
                        self[pos:pos + bits_needed] = rev
                        swaps += 1
                        pos += bits_needed
        else:
            for sz in byte_sizes:
                if sz == 0:
                    nbytes = (end - pos) // 8
                    if nbytes <= 1:
                        return swaps
                    sub = self[pos:pos + nbytes * 8]
                    rev = Bits()
                    for i in range(nbytes):
                        rev = Bits() + rev + sub[i * 8:(i + 1) * 8]
                    self[pos:pos + nbytes * 8] = rev
                    swaps += 1
                    pos += nbytes * 8
                else:
                    bits_needed = sz * 8
                    if pos + bits_needed > end:
                        return swaps
                    sub = self[pos:pos + bits_needed]
                    rev = Bits()
                    for i in range(sz):
                        rev = Bits() + rev + sub[i * 8:(i + 1) * 8]
                    self[pos:pos + bits_needed] = rev
                    swaps += 1
                    pos += bits_needed
        return swaps

    def clear(self):
        self._data = bytearray()
        self._bitlength = 0

    def rol(self, bits, start=None, end=None):
        if start is None:
            start = 0
        if end is None:
            end = self._bitlength
        slice_len = end - start
        if slice_len == 0:
            return
        bits = bits % slice_len
        sub = self[start:end]
        rotated = sub[bits:] + sub[:bits]
        self[start:end] = rotated

    def ror(self, bits, start=None, end=None):
        if start is None:
            start = 0
        if end is None:
            end = self._bitlength
        slice_len = end - start
        if slice_len == 0:
            return
        bits = bits % slice_len
        sub = self[start:end]
        rotated = sub[-bits:] + sub[:-bits]
        self[start:end] = rotated


class ConstBitStream(Bits):
    def __init__(self, auto=None, /, length=None, offset=None, pos=0, **kwargs):
        super().__init__(auto, length=length, offset=offset, **kwargs)
        self._pos = pos

    @property
    def pos(self):
        return self._pos

    @pos.setter
    def pos(self, value):
        if value < 0 or value > self._bitlength:
            raise ValueError(f"pos out of range: {value}")
        self._pos = value

    @property
    def bytepos(self):
        return self._pos // 8

    @bytepos.setter
    def bytepos(self, value):
        self._pos = value * 8

    def bytealign(self):
        if self._pos % 8 != 0:
            self._pos = (self._pos // 8 + 1) * 8

    def read(self, fmt):
        if isinstance(fmt, int):
            if self._pos + fmt > self._bitlength:
                raise ReadError("Cannot read past end of bitstring")
            result = self[self._pos:self._pos + fmt]
            self._pos += fmt
            return result

        tokens = _parse_read_fmt(fmt)
        if len(tokens) == 1:
            return self._read_single(tokens[0])
        return self.readlist(fmt)

    def _read_single(self, token):
        result = self._parse_token(token)
        return result

    def _parse_token(self, token):
        token = token.strip()
        if not token:
            return None

        if token.startswith('0x') or token.startswith('0X') or \
           token.startswith('0b') or token.startswith('0B') or \
           token.startswith('0o') or token.startswith('0O'):
            d, bl = _str_to_bits(token)
            start = self._pos
            self._pos += bl
            return Bits.__new_instance(bytearray(d), bl)

        if '=' in token:
            parts = token.split('=')
            fmt_token = parts[0].strip()
            d, bl = _parse_format_token(fmt_token + '=' + parts[1].strip(), parts[1].strip())
            start = self._pos
            self._pos += bl
            return Bits.__new_instance(bytearray(d), bl)

        colon_idx = token.find(':')
        if colon_idx >= 0:
            name = token[:colon_idx]
            length_str = token[colon_idx + 1:]
        else:
            name = token
            length_str = None

        length = int(length_str) if length_str and length_str.isdigit() else None

        base_name = name
        if length is None:
            for n in ['int', 'uint', 'intbe', 'intle',
                      'uintbe', 'uintle',
                      'float', 'floatbe', 'floatle',
                      'bin', 'hex', 'oct', 'bytes', 'bits']:
                if name.startswith(n):
                    rest = name[len(n):]
                    if rest and rest.isdigit():
                        length = int(rest)
                        base_name = n
                    break

        if length is None:
            length = self._bitlength - self._pos

        start = self._pos
        end = min(start + length, self._bitlength)
        chunk = self[start:end]
        self._pos = end

        name_lower = base_name.lower()
        if name_lower in ('bin', 'b'):
            return chunk.bin
        elif name_lower in ('hex', 'h'):
            return chunk.hex
        elif name_lower in ('oct', 'o'):
            return chunk.oct
        elif name_lower == 'uint' or name_lower == 'u':
            return chunk.uint
        elif name_lower == 'int' or name_lower == 'i':
            return chunk.int
        elif name_lower == 'float' or name_lower == 'f':
            return chunk.float
        elif name_lower == 'bool':
            return chunk.bool
        elif name_lower == 'bytes':
            return chunk.tobytes()
        elif name_lower == 'bits':
            return chunk
        elif name_lower in ('uintbe',):
            return chunk.uintbe
        elif name_lower in ('uintle',):
            return chunk.uintle
        elif name_lower in ('intbe',):
            return chunk.intbe
        elif name_lower in ('intle',):
            return chunk.intle
        elif name_lower in ('floatbe',):
            return chunk.float
        elif name_lower in ('floatle',):
            return chunk.floatle
        elif name_lower == 'pad':
            return None
        else:
            raise InterpretError(f"Unknown format: {name}")

    def readlist(self, fmt, **kwargs):
        tokens = _parse_read_fmt(fmt)
        result = []
        for token in tokens:
            result.append(self._parse_token(token))
        return result

    def readto(self, bs):
        if isinstance(bs, Bits):
            target = bs
        else:
            target = Bits(bs)
        found_pos = -1
        target_len = target._bitlength
        max_pos = self._bitlength - target_len
        for p in range(self._pos, max_pos + 1):
            if self[p:p + target_len] == target:
                found_pos = p
                break
        if found_pos == -1:
            raise ReadError("Substring not found")
        result = self[self._pos:found_pos + target_len]
        self._pos = found_pos + target_len
        return result

    def peek(self, fmt):
        saved_pos = self._pos
        try:
            return self.read(fmt)
        finally:
            self._pos = saved_pos

    def peeklist(self, fmt, **kwargs):
        saved_pos = self._pos
        try:
            return self.readlist(fmt, **kwargs)
        finally:
            self._pos = saved_pos


class BitStream(ConstBitStream, BitArray):
    def __init__(self, auto=None, /, length=None, offset=None, pos=0, **kwargs):
        ConstBitStream.__init__(self, auto, length=length, offset=offset, pos=pos, **kwargs)

    def insert(self, bs, pos=None):
        if pos is None:
            pos = self._pos
        BitArray.insert(self, bs, pos)

    def overwrite(self, bs, pos=None):
        if pos is None:
            pos = self._pos
        BitArray.overwrite(self, bs, pos)


def pack(fmt, *values, **kwargs):
    parts = [p.strip() for p in fmt.split(',')]
    all_data = bytearray()
    all_bits = 0
    value_idx = 0

    resolved = {}
    if kwargs:
        resolved.update(kwargs)

    for part in parts:
        if not part:
            continue

        if part.startswith('0x') or part.startswith('0X') or \
           part.startswith('0b') or part.startswith('0B') or \
           part.startswith('0o') or part.startswith('0O'):
            d, bl = _str_to_bits(part)
            all_data.extend(d)
            all_bits += bl
            continue

        if '=' in part:
            name_val = part.split('=', 1)
            name = name_val[0].strip()
            val_str = name_val[1].strip()
            if name in resolved:
                d, bl = _parse_format_token(f"{name}={resolved[name]}", str(resolved[name]))
            else:
                d, bl = _parse_format_token(part, val_str)
            all_data.extend(d)
            all_bits += bl
            continue

        if part[0] in '<> =':
            d, bl, value_idx = _pack_compact(part, values, value_idx)
            all_data.extend(d)
            all_bits += bl
            continue

        colon_idx = part.find(':')
        if colon_idx >= 0:
            name = part[:colon_idx]
            len_str = part[colon_idx + 1:]
        else:
            name = part
            len_str = None

        if len_str and len_str in resolved:
            len_str = str(resolved[len_str])

        if name in resolved:
            val = resolved[name]
            if isinstance(val, Bits):
                d = bytearray(val._data)
                bl = val._bitlength
            elif isinstance(val, str):
                d, bl = _str_to_bits(val)
            else:
                if len_str:
                    d, bl = _parse_format_token(f"uint:{len_str}={val}", str(val))
                else:
                    d, bl = _parse_format_token(f"uint={val}", str(val))
            all_data.extend(d)
            all_bits += bl
            continue

        if len_str:
            fmt_full = f"{name}:{len_str}"
        else:
            fmt_full = f"{name}"

        if value_idx < len(values):
            val = values[value_idx]
            value_idx += 1
            if isinstance(val, Bits):
                d = bytearray(val._data)
                bl = val._bitlength
            elif isinstance(val, str):
                d, bl = _str_to_bits(val)
            else:
                d, bl = _parse_format_token(f"{fmt_full}={val}", str(val))
            all_data.extend(d)
            all_bits += bl
        else:
            d, bl = _parse_format_token(part, '0')
            all_data.extend(d)
            all_bits += bl

    if value_idx < len(values):
        raise ValueError(f"{len(values) - value_idx} unused value(s) in pack")

    result = BitStream.__new__(BitStream)
    result._data = all_data
    result._bitlength = all_bits
    result._pos = 0
    return result


def _pack_compact(fmt, values, idx):
    endian = fmt[0]
    rest = fmt[1:]
    if endian == '>':
        ep = '>'
    elif endian == '<':
        ep = '<'
    else:
        ep = '='

    fmt_map = {
        'b': ('b', 1), 'B': ('B', 1),
        'h': ('h', 2), 'H': ('H', 2),
        'i': ('i', 4), 'I': ('I', 4),
        'l': ('i', 4), 'L': ('I', 4),
        'q': ('q', 8), 'Q': ('Q', 8),
        'e': ('e', 2), 'f': ('f', 4), 'd': ('d', 8),
    }

    i = 0
    all_data = bytearray()
    while i < len(rest):
        c = rest[i]
        count = 1
        j = i + 1
        while j < len(rest) and rest[j].isdigit():
            j += 1
        if j > i + 1:
            count = int(rest[i + 1:j])
        if c in fmt_map:
            fc, sz = fmt_map[c]
            for _ in range(count):
                packed = struct.pack(ep + fc, values[idx])
                idx += 1
                all_data.extend(packed)
        else:
            raise CreationError(f"Unknown format character: {c}")
        i = j
    return all_data, len(all_data) * 8, idx
